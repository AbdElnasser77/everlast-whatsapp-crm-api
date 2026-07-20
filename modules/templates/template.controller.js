const axios = require("axios");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { sendWhatsAppMessage } = require("../../utils/whatsappClient");
const { getIO } = require("../../utils/socket");
const { toMetaPositionalBody, buildTemplateParams, resolveNamedVars } = require("../../utils/templateVars");

const VALID_CATEGORIES = ["GENERAL", "RE_ENGAGEMENT", "CAMPAIGN"];
const VALID_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED"];
const HEADER_TYPES = ["NONE", "TEXT", "IMAGE", "VIDEO", "DOCUMENT"];
const BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER"];
// Meta's own per-message billing category, mapped from this CRM's category —
// kept in sync with the frontend's cost estimator (campaigns/new/page.tsx).
const META_TEMPLATE_CATEGORY = { GENERAL: "UTILITY", RE_ENGAGEMENT: "MARKETING", CAMPAIGN: "MARKETING" };
const WINDOW_MS = 24 * 60 * 60 * 1000;
const BODY_MAX_LENGTH = 800; // kept in sync with the frontend's LIMITS.body
const getApiVersion = () => process.env.WHATSAPP_API_VERSION || "v19.0";
const PLACEHOLDER_RE = /\{\{\s*[a-z0-9_]+\s*\}\}/gi;

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
async function uploadHeaderMediaHandle(mediaUrl) {
  const appId = process.env.WHATSAPP_APP_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
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
    const where = { isActive: true };
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
    if (!body) return next(new AppError("body is required", 400));
    if (body.length > BODY_MAX_LENGTH) return next(new AppError(`Body must be ${BODY_MAX_LENGTH} characters or fewer`, 400));
    if (category && !VALID_CATEGORIES.includes(category)) {
      return next(new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400));
    }

    const headerFields = validateHeader(headerType, header, headerMediaUrl);
    const validatedButtons = validateButtons(buttons);

    const template = await prisma.template.create({
      data: {
        name,
        category: category || "GENERAL",
        language: language || "en_US",
        ...headerFields,
        body,
        footer: footer || null,
        buttons: validatedButtons,
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
    const existing = await prisma.template.findUnique({ where: { id } });
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

    const headerFields = headerType !== undefined ? validateHeader(headerType, header, headerMediaUrl) : null;
    const validatedButtons = buttons !== undefined ? validateButtons(buttons) : existing.buttons;

    const template = await prisma.template.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(category && { category }),
        ...(language && { language }),
        ...(headerFields || {}),
        ...(body && { body }),
        footer: footer !== undefined ? footer : existing.footer,
        buttons: validatedButtons,
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
    const existing = await prisma.template.findUnique({ where: { id } });
    if (!existing || !existing.isActive) return next(new AppError("Template not found", 404));

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

    const wabaId = process.env.WHATSAPP_WABA_ID;
    if (!wabaId) return next(new AppError("WHATSAPP_WABA_ID is not configured", 500));

    const metaName = template.metaTemplateName || toMetaName(template.name);

    // Build Meta components
    const components = [];
    if (template.headerType === "TEXT" && template.header) {
      components.push({ type: "HEADER", format: "TEXT", text: template.header });
    } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(template.headerType) && template.headerMediaUrl) {
      let handle;
      try {
        handle = await uploadHeaderMediaHandle(template.headerMediaUrl);
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
        { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } },
      );
    } catch (metaErr) {
      const detail = metaErr.response?.data || metaErr.message;
      console.error("Meta template submission failed:", JSON.stringify(detail));
      return next(new AppError("Failed to submit template to Meta", 502));
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

const syncApprovalStatus = async (req, res, next) => {
  try {
    const submitted = await prisma.template.findMany({
      where: { approvalStatus: "SUBMITTED", isActive: true },
    });

    if (submitted.length === 0) {
      return res.status(200).json({ success: true, message: "No submitted templates to sync", updated: 0 });
    }

    let approved = 0;
    let rejected = 0;

    await Promise.all(
      submitted.map(async (t) => {
        if (!t.metaTemplateId) return;
        try {
          const metaRes = await axios.get(
            `https://graph.facebook.com/${getApiVersion()}/${t.metaTemplateId}`,
            { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } },
          );
          const status = metaRes.data?.status;
          if (status === "APPROVED") {
            await prisma.template.update({ where: { id: t.id }, data: { approvalStatus: "APPROVED" } });
            approved++;
          } else if (status === "REJECTED") {
            const reason = metaRes.data?.rejected_reason || null;
            await prisma.template.update({
              where: { id: t.id },
              data: { approvalStatus: "REJECTED", rejectionReason: reason },
            });
            rejected++;
          }
        } catch (err) {
          console.error(`Sync failed for template ${t.id}:`, err.message);
        }
      }),
    );

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
    if (!conversation) return next(new AppError("Conversation not found", 404));

    const template = await prisma.template.findUnique({ where: { id: parseInt(templateId) } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));

    // RE_ENGAGEMENT and CAMPAIGN require APPROVED status
    if (template.category !== "GENERAL" && template.approvalStatus !== "APPROVED") {
      return next(new AppError(`${template.category} templates must be APPROVED before sending`, 400));
    }

    // 24h window check for RE_ENGAGEMENT
    if (template.category === "RE_ENGAGEMENT") {
      if (!conversation.lastCustomerMessageAt) {
        return next(new AppError("No customer message found in this conversation", 400));
      }
      const elapsed = Date.now() - new Date(conversation.lastCustomerMessageAt).getTime();
      if (elapsed < WINDOW_MS) {
        return next(new AppError("24-hour window is still open — send a regular message instead", 400));
      }
    }

    const resolvedBody = resolveNamedVars(template.body, conversation.customer, req.user);
    const hasButtons = template.buttons && Array.isArray(template.buttons) && template.buttons.length > 0;
    // Only RE_ENGAGEMENT and CAMPAIGN with a valid metaTemplateName use Meta's template format
    // GENERAL templates always send as regular text/interactive regardless of approval status
    const needsMetaTemplate = template.category !== "GENERAL" && template.approvalStatus === "APPROVED" && !!template.metaTemplateName;
    const messageType = needsMetaTemplate ? "TEMPLATE" : (hasButtons ? "INTERACTIVE" : "TEXT");

    // Store full template structure as JSON so the frontend can render header/body/footer/buttons
    const resolvedHeader = template.headerType === "TEXT" && template.header
      ? resolveNamedVars(template.header, conversation.customer, req.user)
      : null;
    const templateContent = JSON.stringify({
      headerType: template.headerType,
      header: resolvedHeader || undefined,
      headerMediaUrl: template.headerMediaUrl || undefined,
      body: resolvedBody,
      footer: template.footer || undefined,
      buttons: hasButtons ? template.buttons : undefined,
    });

    // Positional params matching the submitted template (order of appearance).
    const templateVariables = buildTemplateParams(template.body, conversation.customer, req.user);

    let message = await prisma.message.create({
      data: {
        conversationId,
        senderType: "AGENT",
        senderId: parseInt(req.user.id),
        content: templateContent,
        messageType: "INTERACTIVE",
        status: "PENDING",
      },
    });

    try {
      const { whatsappMessageId } = await sendWhatsAppMessage({
        to: conversation.customer.phone,
        content: resolvedBody,
        messageType,
        buttons: hasButtons ? template.buttons : null,
        headerType: template.headerType,
        header: resolvedHeader,
        headerMediaUrl: template.headerMediaUrl || null,
        footer: template.footer || null,
        templateName: template.metaTemplateName,
        language: template.language,
        templateVariables,
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

    const io = getIO();
    io.emit("message.created", { message, conversationId });
    io.emit("conversation.updated", { conversationId });

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
