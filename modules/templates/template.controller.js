const axios = require("axios");
const { Prisma } = require("@prisma/client");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { sendWhatsAppMessage } = require("../../utils/whatsappClient");
const numbers = require("../../utils/whatsappNumbers");
const { emitToNumber } = require("../../utils/socket");
const { claimIfUnassigned } = require("../../utils/conversationAssignment");
const { handOffOnAgentReply } = require("../../utils/flowEngine");
const { buildTemplateSend } = require("../../utils/templateSend");
const { windowState, windowClosedError } = require("../../utils/messagingWindow");
const { describeMetaTemplateError } = require("../../utils/metaErrors");
const { syncSubmittedTemplates } = require("../../utils/templateStatus");
const { toMetaPositionalBody, buildTemplateParams, listPlaceholders, SUPPORTED_VARS } = require("../../utils/templateVars");

const VALID_CATEGORIES = ["GENERAL", "RE_ENGAGEMENT", "CAMPAIGN"];
const VALID_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"];
const HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"];
const BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER"];
// Meta's own per-message billing category, mapped from this CRM's category —
// kept in sync with the frontend's cost estimator (campaigns/new/page.tsx).
const META_TEMPLATE_CATEGORY = { GENERAL: "UTILITY", RE_ENGAGEMENT: "MARKETING", CAMPAIGN: "MARKETING" };
const BODY_MAX_LENGTH = 800; // kept in sync with the frontend's LIMITS.body
const getApiVersion = () => process.env.WHATSAPP_API_VERSION || "v19.0";
const PLACEHOLDER_RE = /\{\{\s*[a-z0-9_]+\s*\}\}/gi;

// Meta rejects a text header containing newlines, emojis or WhatsApp
// formatting characters. Placeholders are removed first — the underscore in
// {{customer_name}} is fine, it becomes {{1}} before Meta sees it.
const HEADER_FORBIDDEN_RE = /[\r\n*_~`]|\p{Extended_Pictographic}/u;
const headerCharError = (text) => {
  const bad = text.replace(/\{\{[^{}]*\}\}/g, "").match(HEADER_FORBIDDEN_RE);
  return bad
    ? `The header can't contain "${bad[0] === "\n" ? "a new line" : bad[0]}" — Meta doesn't allow newlines, emojis or formatting characters (* _ ~ \`) in a header`
    : null;
};

// Validate the header type/content combination. Returns the clean triple to
// persist — {headerType, header, headerMediaUrl} — so switching types never
// leaves a stale value from the previous type behind.
function validateHeader(headerType, header, headerMediaUrl) {
  const type = headerType || "NONE";
  if (!HEADER_TYPES.includes(type)) {
    throw new AppError(`Invalid headerType. Must be one of: ${HEADER_TYPES.join(", ")}`, 400);
  }
  if (type === "NONE") return { headerType: "NONE", header: null, headerMediaUrl: null };
  if (type === "TEXT") {
    const text = (header || "").trim();
    if (!text) throw new AppError("Header text is required when the header type is Text", 400);
    if (text.length > 60) throw new AppError("Header text must be 60 characters or fewer", 400);
    const charErr = headerCharError(text);
    if (charErr) throw new AppError(charErr, 400);
    // Meta allows exactly one variable in a text header.
    const vars = listPlaceholders(text);
    if (vars.length > 1) throw new AppError("A text header can have at most 1 placeholder", 400);
    if (vars.length === 1 && !SUPPORTED_VARS.includes(vars[0].toLowerCase())) {
      throw new AppError(`Unknown placeholder {{${vars[0]}}} in the header. Use one of: ${SUPPORTED_VARS.join(", ")}`, 400);
    }
    return { headerType: "TEXT", header: text, headerMediaUrl: null };
  }
  // IMAGE / VIDEO / DOCUMENT — a sample media URL is required so Meta can
  // generate the media handle needed for approval.
  const url = (headerMediaUrl || "").trim();
  if (!url) throw new AppError(`A sample ${type.toLowerCase()} URL is required for a ${type.toLowerCase()} header`, 400);
  if (!/^https?:\/\//i.test(url)) throw new AppError("Header media URL must start with http:// or https://", 400);
  return { headerType: type, header: null, headerMediaUrl: url };
}

// Validate buttons against WhatsApp's real rules: max 3 total, titles ≤25
// chars with no placeholders, and Quick Reply buttons can't be mixed with
// Call/URL buttons — it's one or the other, matching Meta's own constraint.
const validateButtons = (buttons) => {
  if (!buttons) return null;
  if (!Array.isArray(buttons)) throw new AppError("buttons must be an array", 400);
  if (buttons.length === 0) return null;
  if (buttons.length > 3) throw new AppError("Maximum 3 buttons allowed", 400);

  const types = new Set();
  let urlCount = 0;
  let phoneCount = 0;

  const cleaned = buttons.map((b) => {
    const title = String(b?.title ?? "").trim();
    if (!b?.id || !title) throw new AppError("Each button needs an id and a title", 400);
    if (title.length > 25) throw new AppError(`Button title "${title}" exceeds 25 characters`, 400);
    if (PLACEHOLDER_RE.test(title)) throw new AppError("Button titles can't contain placeholders", 400);

    const type = b.type || "QUICK_REPLY";
    if (!BUTTON_TYPES.includes(type)) throw new AppError(`Invalid button type "${type}"`, 400);
    types.add(type);

    if (type === "PHONE_NUMBER") {
      phoneCount++;
      const phoneNumber = String(b.phoneNumber ?? "").trim();
      if (!phoneNumber) throw new AppError("A phone number is required for a Call Number button", 400);
      if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) throw new AppError(`"${phoneNumber}" isn't a valid phone number`, 400);
      return { id: b.id, type, title, phoneNumber };
    }
    if (type === "URL") {
      urlCount++;
      const url = String(b.url ?? "").trim();
      if (!url) throw new AppError("A URL is required for a URL button", 400);
      if (!/^https?:\/\//i.test(url)) throw new AppError("Button URL must start with http:// or https://", 400);
      const placeholders = url.match(PLACEHOLDER_RE) || [];
      if (placeholders.length > 1) throw new AppError("A URL button can have at most 1 placeholder", 400);
      return { id: b.id, type, title, url };
    }
    return { id: b.id, type: "QUICK_REPLY", title };
  });

  if (types.has("QUICK_REPLY") && types.size > 1) {
    throw new AppError("Buttons can't mix Quick Reply with Call Number/URL buttons — use one or the other", 400);
  }
  if (phoneCount > 1) throw new AppError("Only 1 Call Number button is allowed per template", 400);
  if (urlCount > 2) throw new AppError("A maximum of 2 URL buttons is allowed per template", 400);

  return cleaned;
};

// Carousel cards, validated against Meta's media-card carousel rules: 2–10
// cards, every card the SAME shape (same media type, same button types in the
// same order — Meta rejects a carousel whose cards differ), card text ≤160
// characters, 1–2 buttons per card (Quick Reply and/or URL). Button ids are
// normalized to their position (b0, b1): a tap on card 3's first button is
// then "card 2, b0" everywhere — at send time, in flows, in the inbox.
const CARD_MEDIA_TYPES = ["IMAGE", "VIDEO"];
const CARD_BUTTON_TYPES = ["QUICK_REPLY", "URL"];
const CARD_BODY_MAX = 160;
const HAS_PLACEHOLDER = new RegExp(PLACEHOLDER_RE.source, "i"); // non-global: .test() keeps no state

function validateCards(cards) {
  if (cards === undefined || cards === null) return null;
  if (!Array.isArray(cards)) throw new AppError("cards must be an array", 400);
  if (cards.length < 2 || cards.length > 10) throw new AppError("A carousel needs between 2 and 10 cards", 400);

  const shape = (c) => `${c.mediaType}|${(c.buttons || []).map((b) => b.type || "QUICK_REPLY").join(",")}`;
  const cleaned = cards.map((c, i) => {
    const n = i + 1;
    const mediaType = c?.mediaType || "IMAGE";
    if (!CARD_MEDIA_TYPES.includes(mediaType)) throw new AppError(`Card ${n}: media must be an image or a video`, 400);
    const mediaUrl = String(c?.mediaUrl || "").trim();
    if (!/^https?:\/\//i.test(mediaUrl)) throw new AppError(`Card ${n} needs its ${mediaType.toLowerCase()}`, 400);
    const body = String(c?.body || "").trim();
    if (!body) throw new AppError(`Card ${n} needs some text`, 400);
    if (body.length > CARD_BODY_MAX) throw new AppError(`Card ${n}'s text is ${body.length} characters — the limit is ${CARD_BODY_MAX}`, 400);
    if (HAS_PLACEHOLDER.test(body)) throw new AppError(`Card ${n}: placeholders aren't supported in card text`, 400);
    const buttons = Array.isArray(c?.buttons) ? c.buttons : [];
    if (buttons.length < 1 || buttons.length > 2) throw new AppError(`Card ${n} needs 1 or 2 buttons`, 400);
    return {
      mediaType,
      mediaUrl,
      body,
      buttons: buttons.map((b, j) => {
        const type = b?.type || "QUICK_REPLY";
        if (!CARD_BUTTON_TYPES.includes(type)) throw new AppError(`Card ${n}: buttons can be Quick Reply or URL`, 400);
        const title = String(b?.title || "").trim();
        if (!title) throw new AppError(`Card ${n}: every button needs a title`, 400);
        if (title.length > 25) throw new AppError(`Card ${n}: button "${title}" exceeds 25 characters`, 400);
        if (HAS_PLACEHOLDER.test(title)) throw new AppError("Button titles can't contain placeholders", 400);
        if (type === "URL") {
          const url = String(b?.url || "").trim();
          if (!/^https?:\/\//i.test(url)) throw new AppError(`Card ${n}: "${title}" needs a link starting with https://`, 400);
          if (HAS_PLACEHOLDER.test(url)) throw new AppError(`Card ${n}: placeholders aren't supported in card links`, 400);
          return { id: `b${j}`, type, title, url };
        }
        return { id: `b${j}`, type, title };
      }),
    };
  });
  const first = shape(cleaned[0]);
  const odd = cleaned.findIndex((c) => shape(c) !== first);
  if (odd !== -1) {
    throw new AppError(
      `Card ${odd + 1} is laid out differently from card 1 — every card needs the same media type and the same buttons in the same order`,
      400,
    );
  }
  return cleaned;
}

const toMetaName = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Meta only accepts these mimetypes for template headers. Anything else (very
// commonly WebP/HEIC/GIF images) is rejected with a cryptic "File Type Not
// Supported" error at submission time.
const META_HEADER_IMAGE_MIME = ["image/jpeg", "image/png"];

// If a Cloudinary delivery URL points at an unsupported image format, rewrite it
// to force on-the-fly conversion to PNG (f_png). Returns null for non-Cloudinary
// URLs (nothing we can transform).
function cloudinaryAsPng(url) {
  if (!/res\.cloudinary\.com\/[^/]+\/image\/upload\//.test(url)) return null;
  return url.replace("/image/upload/", "/image/upload/f_png/");
}

// Uploads a remote media file to Meta's resumable upload API and returns the
// media "handle" needed to submit a template with an IMAGE/VIDEO/DOCUMENT
// header for approval. Requires WHATSAPP_APP_ID (separate from the WABA id).
async function uploadHeaderMediaHandle(mediaUrl, { appId, accessToken }) {
  if (!appId) {
    throw new AppError("WHATSAPP_APP_ID is not configured — required to submit templates with an image/video/document header", 500);
  }

  let file = await axios.get(mediaUrl, { responseType: "arraybuffer" });
  let contentType = file.headers["content-type"] || "application/octet-stream";

  // Auto-fix unsupported image headers (e.g. WebP) so Meta doesn't reject them.
  if (contentType.startsWith("image/") && !META_HEADER_IMAGE_MIME.includes(contentType)) {
    const pngUrl = cloudinaryAsPng(mediaUrl);
    if (pngUrl) {
      file = await axios.get(pngUrl, { responseType: "arraybuffer" });
      contentType = file.headers["content-type"] || "image/png";
    } else {
      throw new AppError(
        `Template header images must be JPEG or PNG — this file is ${contentType}. Please re-upload it as a JPEG or PNG.`,
        400,
      );
    }
  }

  const fileBuffer = Buffer.from(file.data);

  const session = await axios.post(
    `https://graph.facebook.com/${getApiVersion()}/${appId}/uploads`,
    null,
    { params: { file_length: fileBuffer.length, file_type: contentType, access_token: accessToken } },
  );
  const uploadSessionId = session.data?.id;
  if (!uploadSessionId) throw new AppError("Meta did not return an upload session id", 502);

  const uploaded = await axios.post(
    `https://graph.facebook.com/${getApiVersion()}/${uploadSessionId}`,
    fileBuffer,
    { headers: { Authorization: `OAuth ${accessToken}`, file_offset: "0", "Content-Type": contentType } },
  );
  const handle = uploaded.data?.h;
  if (!handle) throw new AppError("Meta did not return a media handle", 502);
  return handle;
}

const getTemplates = async (req, res, next) => {
  try {
    // Templates belong to a WABA, so two numbers on the same WABA see one shared
    // library and two numbers on different WABAs see none of each other's. That
    // fall-out is the whole reason wabaId is the key rather than the number id.
    const where = { isActive: true, wabaId: req.number.wabaId };
    if (req.query.category) {
      if (!VALID_CATEGORIES.includes(req.query.category)) {
        return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
      }
      where.category = req.query.category;
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return next(new AppError(`Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`, 400));
      }
      where.approvalStatus = req.query.status;
    }

    const templates = await prisma.template.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ success: true, data: templates });
  } catch (err) {
    next(err);
  }
};

const createTemplate = async (req, res, next) => {
  try {
    const { name, category, language, headerType, header, headerMediaUrl, body, footer, buttons } = req.body;
    if (!name) return next(new AppError("name is required", 400));
    const cards = validateCards(req.body.cards);
    if (cards && (category || "GENERAL") === "GENERAL") {
      return next(new AppError("A carousel is a marketing template — choose Campaign or Re-engagement as the category", 400));
    }
    if (!body) return next(new AppError("body is required", 400));
    if (body.length > BODY_MAX_LENGTH) return next(new AppError(`Body must be ${BODY_MAX_LENGTH} characters or fewer`, 400));
    if (category && !VALID_CATEGORIES.includes(category)) {
      return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
    }

    // A carousel's only free text is the body above the cards: no header,
    // footer or message-level buttons (Meta's rule for carousel templates).
    const headerFields = cards ? validateHeader("NONE") : validateHeader(headerType, header, headerMediaUrl);
    const validatedButtons = cards ? null : validateButtons(buttons);

    const template = await prisma.template.create({
      data: {
        name,
        // Fixed at creation and never editable: a template is submitted to, and
        // approved by, one specific WhatsApp Business Account.
        wabaId: req.number.wabaId,
        category: category || "GENERAL",
        language: language || "en_US",
        ...headerFields,
        body,
        footer: cards ? null : footer || null,
        buttons: validatedButtons,
        cards,
      },
    });

    res.status(201).json({ success: true, data: template });
  } catch (err) {
    next(err);
  }
};

const updateTemplate = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    // 404 rather than 403 for another WABA's template — its existence is not
    // something a caller on a different account needs confirmed.
    const existing = await prisma.template.findFirst({
      where: { id, wabaId: req.number.wabaId },
    });
    if (!existing || !existing.isActive) return next(new AppError("Template not found", 404));

    if (existing.approvalStatus === "SUBMITTED" || existing.approvalStatus === "APPROVED") {
      return next(new AppError("Cannot edit a SUBMITTED or APPROVED template", 400));
    }

    const { name, category, language, headerType, header, headerMediaUrl, body, footer, buttons } = req.body;
    if (category && !VALID_CATEGORIES.includes(category)) {
      return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
    }
    if (body !== undefined && body.length > BODY_MAX_LENGTH) {
      return next(new AppError(`Body must be ${BODY_MAX_LENGTH} characters or fewer`, 400));
    }

    // cards: undefined = unchanged, null/[] = back to a standard template.
    const cards = req.body.cards !== undefined
      ? (Array.isArray(req.body.cards) && req.body.cards.length === 0 ? null : validateCards(req.body.cards))
      : existing.cards;
    if (cards && (category || existing.category) === "GENERAL") {
      return next(new AppError("A carousel is a marketing template — choose Campaign or Re-engagement as the category", 400));
    }
    const headerFields = cards
      ? validateHeader("NONE")
      : headerType !== undefined ? validateHeader(headerType, header, headerMediaUrl) : null;
    const validatedButtons = cards ? null : buttons !== undefined ? validateButtons(buttons) : existing.buttons;

    const template = await prisma.template.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(category && { category }),
        ...(language && { language }),
        ...(headerFields || {}),
        ...(body && { body }),
        footer: cards ? null : footer !== undefined ? footer : existing.footer,
        buttons: validatedButtons,
        cards: cards ?? Prisma.DbNull,
        approvalStatus: "DRAFT",
        rejectionReason: null,
      },
    });

    res.status(200).json({ success: true, data: template });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Template not found", 404));
    next(err);
  }
};

const deleteTemplate = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    // 404 rather than 403 for another WABA's template — its existence is not
    // something a caller on a different account needs confirmed.
    const existing = await prisma.template.findFirst({
      where: { id, wabaId: req.number.wabaId },
    });
    if (!existing || !existing.isActive) return next(new AppError("Template not found", 404));

    // Deleting at Meta stops every send of this template, so refuse while a
    // campaign still needs it rather than failing that campaign mid-send.
    const inUse = await prisma.campaign.count({
      where: { templateId: id, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
    });
    if (inUse > 0) {
      return next(new AppError(
        `${inUse} scheduled, running or paused campaign(s) still use this template — finish or cancel them first`,
        409,
      ));
    }

    // A template that was ever submitted also exists in WhatsApp Manager.
    // Hiding it here alone left it there; delete it at Meta first, so the two
    // never disagree. Meta keeps the name reserved for 30 days afterwards.
    if (existing.metaTemplateName) {
      try {
        const credentials = await numbers.getCredentials(req.numberId);
        await axios.delete(`https://graph.facebook.com/${getApiVersion()}/${existing.wabaId}/message_templates`, {
          params: {
            name: existing.metaTemplateName,
            ...(existing.metaTemplateId ? { hsm_id: existing.metaTemplateId } : {}),
          },
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
          timeout: 20000,
        });
      } catch (metaErr) {
        const metaError = metaErr.response?.data?.error;
        // Already gone at Meta (deleted in WhatsApp Manager): just hide it here.
        const alreadyGone = /does not exist|not found|nonexisting/i.test(metaError?.error_user_msg || metaError?.message || "");
        if (!alreadyGone) {
          console.error("Meta template delete failed:", JSON.stringify(metaErr.response?.data || metaErr.message));
          return next(new AppError(
            `WhatsApp didn't delete the template: ${metaError?.error_user_msg || metaError?.message || metaErr.message}`,
            metaErr.response ? 422 : 502,
            "META_DELETE_FAILED",
          ));
        }
      }
    }

    await prisma.template.update({ where: { id }, data: { isActive: false } });

    res.status(200).json({ success: true, message: "Template deleted" });
  } catch (err) {
    next(err);
  }
};

const submitForApproval = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const template = await prisma.template.findUnique({ where: { id } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));

    if (template.approvalStatus !== "DRAFT" && template.approvalStatus !== "REJECTED") {
      return next(new AppError("Only DRAFT or REJECTED templates can be submitted", 400));
    }

    // The template's own WABA, not the environment's. The ownership check above
    // already guarantees it equals req.number.wabaId.
    const wabaId = template.wabaId;
    const credentials = await numbers.getCredentials(req.numberId);

    const metaName = template.metaTemplateName || toMetaName(template.name);

    // Build Meta components
    const components = [];
    if (template.headerType === "TEXT" && template.header) {
      // Drafts saved before this rule existed skip validateHeader; catch them
      // here with a clear message instead of Meta's error.
      const charErr = headerCharError(template.header);
      if (charErr) return next(new AppError(charErr, 400, "TEMPLATE_INVALID", { field: "header" }));
      // Same named → positional conversion as the body. Header variables are
      // numbered on their own, so the header's one variable is always {{1}}.
      const headerComponent = { type: "HEADER", format: "TEXT", text: toMetaPositionalBody(template.header) };
      const headerSample = buildTemplateParams(template.header, { name: "Sarah Ahmed" }, { name: "Alex" });
      if (headerSample.length > 0) headerComponent.example = { header_text: headerSample };
      components.push(headerComponent);
    } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(template.headerType) && template.headerMediaUrl) {
      let handle;
      try {
        handle = await uploadHeaderMediaHandle(template.headerMediaUrl, {
          appId: credentials.appId,
          accessToken: credentials.accessToken,
        });
      } catch (uploadErr) {
        if (uploadErr instanceof AppError) return next(uploadErr);
        console.error("Header media upload failed:", uploadErr.response?.data || uploadErr.message);
        return next(new AppError("Failed to upload header media to Meta", 502));
      }
      components.push({ type: "HEADER", format: template.headerType, example: { header_handle: [handle] } });
    }

    // Convert named placeholders to Meta positional {{1}},{{2}} (by order of
    // appearance) and attach example values so Meta can validate on submit.
    const metaBody = toMetaPositionalBody(template.body);
    const bodyComponent = { type: "BODY", text: metaBody };
    const sampleParams = buildTemplateParams(template.body, { name: "Sarah Ahmed" }, { name: "Alex" });
    if (sampleParams.length > 0) {
      bodyComponent.example = { body_text: [sampleParams] };
    }
    components.push(bodyComponent);

    if (template.footer) {
      components.push({ type: "FOOTER", text: template.footer });
    }

    // Carousel: every card's media goes up to Meta as a sample (one handle per
    // card), then the cards ride along as a single CAROUSEL component.
    if (Array.isArray(template.cards) && template.cards.length) {
      const cards = [];
      for (const [i, card] of template.cards.entries()) {
        let handle;
        try {
          handle = await uploadHeaderMediaHandle(card.mediaUrl, { appId: credentials.appId, accessToken: credentials.accessToken });
        } catch (uploadErr) {
          if (uploadErr instanceof AppError) return next(new AppError(`Card ${i + 1}: ${uploadErr.message}`, uploadErr.statusCode || 400));
          console.error(`Carousel card ${i + 1} media upload failed:`, uploadErr.response?.data || uploadErr.message);
          return next(new AppError(`Failed to upload card ${i + 1}'s media to Meta`, 502));
        }
        cards.push({
          components: [
            { type: "HEADER", format: card.mediaType, example: { header_handle: [handle] } },
            { type: "BODY", text: card.body },
            {
              type: "BUTTONS",
              buttons: card.buttons.map((b) =>
                b.type === "URL" ? { type: "URL", text: b.title, url: b.url } : { type: "QUICK_REPLY", text: b.title },
              ),
            },
          ],
        });
      }
      components.push({ type: "CAROUSEL", cards });
    }

    if (template.buttons && Array.isArray(template.buttons) && template.buttons.length > 0) {
      components.push({
        type: "BUTTONS",
        buttons: template.buttons.map((b) => {
          if (b.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: b.title, phone_number: b.phoneNumber };
          if (b.type === "URL") {
            const btn = { type: "URL", text: b.title, url: b.url };
            if (PLACEHOLDER_RE.test(b.url)) {
              btn.example = [b.url.replace(PLACEHOLDER_RE, "sample")];
            }
            return btn;
          }
          return { type: "QUICK_REPLY", text: b.title };
        }),
      });
    }

    let metaRes;
    try {
      metaRes = await axios.post(
        `https://graph.facebook.com/${getApiVersion()}/${wabaId}/message_templates`,
        {
          name: metaName,
          language: template.language,
          category: META_TEMPLATE_CATEGORY[template.category] || "MARKETING",
          components,
        },
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } },
      );
    } catch (metaErr) {
      const detail = metaErr.response?.data || metaErr.message;
      console.error("Meta template submission failed:", JSON.stringify(detail));
      // No response at all = Meta was unreachable; that is worth retrying.
      if (!metaErr.response) {
        return next(new AppError("Couldn't reach Meta — check the connection and try again", 502, "META_UNREACHABLE"));
      }
      // Meta answered and said no: pass on its explanation and the field.
      const { message, field, metaCode, metaSubcode } = describeMetaTemplateError(metaErr.response.data);
      return next(new AppError(message, 422, "META_REJECTED", { field, metaCode, metaSubcode }));
    }

    const updated = await prisma.template.update({
      where: { id },
      data: {
        approvalStatus: "SUBMITTED",
        metaTemplateName: metaName,
        metaTemplateId: String(metaRes.data?.id || ""),
        rejectionReason: null,
      },
    });

    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// Deliberately NOT scoped to the active number. This is global maintenance:
// scoping it to whatever is selected in the dropdown would silently stop
// approval sync for every other WABA, and the symptom — "templates stay
// SUBMITTED forever on the number I'm not looking at" — is near-undiagnosable.
const syncApprovalStatus = async (req, res, next) => {
  try {
    const { approved, rejected, checked } = await syncSubmittedTemplates();
    if (checked === 0) {
      return res.status(200).json({ success: true, message: "No submitted templates to sync", updated: 0 });
    }
    res.status(200).json({ success: true, updated: approved + rejected, approved, rejected });
  } catch (err) {
    next(err);
  }
};

const sendTemplate = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id);
    const { templateId } = req.body;
    if (!templateId) return next(new AppError("templateId is required", 400));

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: true,
        assignedAgent: { select: { id: true, name: true, username: true } },
      },
    });
    if (!conversation || conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }

    const template = await prisma.template.findFirst({
      where: { id: parseInt(templateId), wabaId: req.number.wabaId },
    });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));

    // Credentials come from the conversation's number, which the check above has
    // already confirmed is the active one. A reply always goes out on the line
    // the customer originally wrote to.
    const credentials = await numbers.getCredentials(conversation.whatsappNumberId);

    // RE_ENGAGEMENT and CAMPAIGN require APPROVED status
    if (template.category !== "GENERAL" && template.approvalStatus !== "APPROVED") {
      return next(new AppError(`${template.category} templates must be APPROVED before sending`, 400));
    }

    // Inside the 24-hour window any template may be sent. Outside it (including a
    // contact who has never written) only a Meta-APPROVED template goes out as a
    // real template send; anything else would be sent as an ad-hoc message,
    // which Meta rejects there. This replaced a rule that blocked re-engagement
    // templates INSIDE the window — though Meta accepts templates at any time —
    // and never checked any other template outside it.
    if (!windowState(conversation.lastCustomerMessageAt).open && !buildTemplateSend(template, conversation.customer, req.user).needsMetaTemplate) {
      return next(windowClosedError(conversation.lastCustomerMessageAt));
    }

    // This block used to duplicate utils/templateSend.js inline. Two copies meant
    // every number-aware fix had to be made twice, and a test send would stop
    // being evidence about the real send the moment they drifted.
    const { resolvedBody, templateContent, sendArgs } = buildTemplateSend(
      template,
      conversation.customer,
      req.user,
    );

    let message = await prisma.message.create({
      data: {
        conversationId,
        senderType: "AGENT",
        senderId: parseInt(req.user.id),
        content: templateContent,
        // Was hardcoded to INTERACTIVE even when the send was a TEMPLATE or TEXT.
        messageType: sendArgs.messageType,
        status: "PENDING",
      },
    });

    try {
      const { whatsappMessageId } = await sendWhatsAppMessage({
        number: credentials,
        to: conversation.customer.phone,
        ...sendArgs,
      });
      message = await prisma.message.update({
        where: { id: message.id },
        data: { whatsappMessageId, status: "SENT" },
      });
    } catch (waErr) {
      console.error("WhatsApp template send failed:", waErr.response?.data || waErr.message);
      message = await prisma.message.update({ where: { id: message.id }, data: { status: "FAILED" } });
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessage: resolvedBody,
        lastMessageAt: new Date(),
        lastSenderType: "AGENT",
      },
    });

    // Replying to an unassigned chat takes it, so it leaves the Unassigned queue
    // and nobody else picks it up too. Only on a successful send: a failed send
    // shouldn't quietly take ownership.
    if (message.status === "SENT") {
      await claimIfUnassigned({ conversationId: conversationId, numberId: conversation.whatsappNumberId, user: req.user });
      await handOffOnAgentReply(conversationId);
    }

    emitToNumber(conversation.whatsappNumberId, "message.created", { message, conversationId });
    emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId });

    res.status(201).json({ success: true, data: message });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  syncApprovalStatus,
  sendTemplate,
};
