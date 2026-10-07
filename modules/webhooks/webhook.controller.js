const { handleTemplateStatusWebhook } = require("../../utils/templateStatus");
const prisma = require("../../config/prisma");
const storage = require("../../utils/storage");
const { fetchAndStoreMediaWithRetry } = require("../../utils/whatsappMedia");
const { emitToNumber } = require("../../utils/socket");
const numbers = require("../../utils/whatsappNumbers");
const logAudit = require("../../utils/audit");
const { attributeReply } = require("../../utils/campaignAttribution");
const flowEngine = require("../../utils/flowEngine");

// An unrecognized phone_number_id is almost always a misrouted subscription, and
// Meta will keep sending. Log and audit it once per number per hour so a
// misconfiguration is visible without flooding the audit table.
const unknownNumberSeen = new Map();
const UNKNOWN_NUMBER_LOG_INTERVAL_MS = 60 * 60 * 1000;

// Fire-and-forget download of an incoming media message. Retries a few times so
// a single transient failure doesn't strand the file — and even if all retries
// fail, the message keeps its mediaId, so opening it later re-downloads it
// on demand (see getMessageMedia).
const uploadReceivedMedia = async (messageId, mediaId, messageType, whatsappNumberId) => {
  try {
    await fetchAndStoreMediaWithRetry({ messageId, mediaId, messageType, whatsappNumberId });
    console.log(`Webhook: media uploaded (${storage.activeProvider()}) for message ${messageId}`);
  } catch (err) {
    console.error(`Webhook: media upload failed for message ${messageId} (recoverable on view):`, err.message);
  }
};

const MESSAGE_TYPE_MAP = {
  text: "TEXT",
  image: "IMAGE",
  video: "VIDEO",
  audio: "AUDIO",
  document: "DOCUMENT",
  interactive: "TEXT",
  // A tap on one of an approved template's quick-reply buttons — the most common
  // way a patient answers a campaign. It used to be unmapped, and was saved as
  // "[unsupported: button]".
  button: "TEXT",
  sticker: "STICKER",
};

const extractFromPayload = (body) => {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const msg = change?.messages?.[0];
  const contact = change?.contacts?.[0];

  if (!msg) return null;

  const phone =
    msg.from ||
    contact?.wa_id ||
    contact?.user_id ||
    msg.from_user_id ||
    null;

  if (!phone) return null;

  const name = contact?.profile?.name || contact?.profile?.username || null;

  const rawType = msg.type;

  // Media id, extracted generically: every media sub-object Meta sends is keyed
  // by its own type and carries an `id` (msg.image.id, msg.document.id, ...).
  // Falling back to msg[rawType]?.id means a NEW media type we haven't mapped
  // yet still gets its id captured, so it stays downloadable/recoverable.
  const mediaId =
    msg.image?.id ||
    msg.video?.id ||
    msg.audio?.id ||
    msg.document?.id ||
    msg.sticker?.id ||
    (rawType ? msg[rawType]?.id : null) ||
    null;

  const mappedType = MESSAGE_TYPE_MAP[rawType];

  const content =
    msg.text?.body ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.list_reply?.title ||
    (msg.interactive?.type ? msg.interactive[msg.interactive.type]?.title : null) ||
    msg.button?.text ||
    msg.image?.caption ||
    msg.video?.caption ||
    msg.audio?.caption ||
    msg.document?.caption ||
    (rawType === "sticker" ? "[sticker]" : null) ||
    // Diagnostic placeholder: if we couldn't map the type AND there's no media
    // to download, record what the type actually was instead of a generic label.
    (mediaId || mappedType ? "[media message]" : `[unsupported: ${rawType || "unknown"}]`);

  // If Meta sent a media id under an unmapped type, we still don't know the exact
  // kind — treat it as DOCUMENT so it renders as a downloadable file (never a
  // broken player) while the real bytes are fetched by mediaId.
  const messageType = mappedType || (mediaId ? "DOCUMENT" : "TEXT");

  // WA ID of the message being quoted (present when customer replies to a specific message)
  const quotedWhatsappMessageId = msg.context?.id || null;

  return {
    // Which of our numbers received this. Meta has always sent it; the app
    // simply had no use for it while there was only one line.
    phoneNumberId: change?.metadata?.phone_number_id || null,
    phone,
    name,
    content,
    mediaId,
    messageType,
    rawType,
    isRecognized: Boolean(mappedType),
    whatsappMessageId: msg.id,
    quotedWhatsappMessageId,
    // What a tap actually selected, for flows (utils/flowEngine.js): the id of
    // the button/list row on our own interactive messages, or a template
    // quick-reply's payload. `content` above is only the visible title.
    replyId:
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id ||
      // Any other interactive reply (e.g. a carousel card's quick reply) that
      // carries an id, whatever Meta names the sub-object.
      (msg.interactive?.type ? msg.interactive[msg.interactive.type]?.id : null) ||
      // A carousel card's quick reply sent by a flow carries the flow's id as
      // its payload — same shape as our interactive ids.
      (msg.button?.payload?.startsWith("f:") ? msg.button.payload : null),
    buttonPayload: msg.button?.payload || null,
  };
};

const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.send(challenge);
  }
  // Without this line a rejected verification is invisible here — Meta only
  // shows a generic "couldn't be validated". The token itself is never logged.
  console.warn(
    `Webhook: verification REJECTED (mode=${mode}, token length ${String(token || "").length}, ` +
      `expected ${(process.env.WHATSAPP_VERIFY_TOKEN || "").length}) — check the Verify token in Meta`,
  );
  res.sendStatus(403);
};

const STATUS_MAP = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};
// Meta can deliver statuses out of order (a late "delivered" after "read").
// A status only moves forward; FAILED always applies.
const STATUS_RANK = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };

// WhatsApp's own marketing opt-out ("Offers and announcements" → Stop). Kept as
// a CustomerOptOut with source WHATSAPP, so campaigns skip the customer. It
// never overwrites an existing opt-out's source: a customer who texted STOP
// stays a KEYWORD opt-out.
async function recordWhatsAppMarketingStop(customerId, whatsappNumberId, why) {
  await prisma.customerOptOut.upsert({
    where: { customerId_whatsappNumberId: { customerId, whatsappNumberId } },
    update: {},
    create: { customerId, whatsappNumberId, source: "WHATSAPP" },
  });
  console.log(`Webhook: customer ${customerId} stopped marketing via WhatsApp (${why})`);
  logAudit({
    action: "CUSTOMER_OPTED_OUT",
    actor: null,
    targetType: "Customer",
    targetId: customerId,
    details: { source: "WHATSAPP", whatsappNumberId, why },
  });
}

// field "user_preferences": value.user_preferences[] = { wa_id, category:
// "marketing_messages", value: "stop" | "resume", detail, timestamp }.
const handleUserPreferences = async (value) => {
  const number = await numbers.getByPhoneNumberId(value?.metadata?.phone_number_id);
  if (!number) return;
  for (const pref of value?.user_preferences || []) {
    if (pref.category !== "marketing_messages") continue;
    const customer = await prisma.customer.findUnique({ where: { phone: String(pref.wa_id) } });
    if (!customer) {
      console.log(`Webhook: marketing preference "${pref.value}" for unknown contact — skipped`);
      continue;
    }
    if (pref.value === "stop") {
      await recordWhatsAppMarketingStop(customer.id, number.id, "user_preferences stop");
    } else if (pref.value === "resume") {
      // Only lift WhatsApp's own opt-out; a STOP keyword or a manual opt-out stays.
      const { count } = await prisma.customerOptOut.deleteMany({
        where: { customerId: customer.id, whatsappNumberId: number.id, source: "WHATSAPP" },
      });
      if (count) {
        console.log(`Webhook: customer ${customer.id} resumed marketing via WhatsApp`);
        logAudit({
          action: "CUSTOMER_OPTED_IN",
          actor: null,
          targetType: "Customer",
          targetId: customer.id,
          details: { source: "WHATSAPP", whatsappNumberId: number.id },
        });
      }
    }
  }
};

// Meta may batch several statuses into one payload; each is handled on its own.
const handleStatusUpdate = async (value) => {
  for (const statusEntry of value?.statuses || []) {
    await handleOneStatus(statusEntry);
  }
};

const handleOneStatus = async (statusEntry) => {
  const { id: whatsappMessageId, status } = statusEntry;
  const mapped = STATUS_MAP[status];
  if (!mapped) return;

  // whatsappMessageId is globally unique across Meta, so this lookup stays
  // correct without a number filter — but the emit still has to be scoped.
  const message = await prisma.message.findFirst({
    where: { whatsappMessageId },
    include: { conversation: { select: { whatsappNumberId: true, customerId: true } } },
  });
  if (!message) return;

  // 131050: the customer stopped marketing messages in WhatsApp itself. Record
  // it like any other opt-out so campaigns stop retrying them.
  if (status === "failed" && Number(statusEntry.errors?.[0]?.code) === 131050) {
    await recordWhatsAppMarketingStop(message.conversation.customerId, message.conversation.whatsappNumberId, "send failed with 131050");
  }

  // Meta's billing verdict rides on the sent/delivered statuses. Kept as-is:
  // it is the only authority on whether this message cost money.
  const data = {};
  const goesBack = mapped !== "FAILED" && (STATUS_RANK[message.status] ?? -1) > STATUS_RANK[mapped];
  if (!goesBack) data.status = mapped;
  const pricing = statusEntry.pricing;
  if (pricing && typeof pricing.billable === "boolean") {
    data.billable = pricing.billable;
    data.pricingCategory = pricing.category || null;
    data.pricingType = pricing.type || null;
  }
  if (status === "failed" && statusEntry.errors?.[0]) {
    data.errorCode = Number(statusEntry.errors[0].code) || null;
    data.errorTitle = statusEntry.errors[0].title || null;
  }

  await prisma.message.update({
    where: { id: message.id },
    data,
  });

  // A campaign send Meta accepted and then failed: move that recipient from
  // SENT to FAILED so the campaign's Sent/Failed counts are true.
  if (mapped === "FAILED") {
    const recipients = await prisma.campaignRecipient.findMany({
      where: { messageId: message.id, status: "SENT" },
      select: { id: true, campaignId: true },
    });
    const errText = statusEntry.errors?.[0] ? `${statusEntry.errors[0].code} ${statusEntry.errors[0].title || ""}`.trim() : "Failed after sending";
    for (const r of recipients) {
      const { count } = await prisma.campaignRecipient.updateMany({
        where: { id: r.id, status: "SENT" },
        data: { status: "FAILED", error: errText },
      });
      if (count === 0) continue;
      const updated = await prisma.campaign.update({
        where: { id: r.campaignId },
        data: { sentCount: { decrement: 1 }, failedCount: { increment: 1 } },
        select: { sentCount: true, failedCount: true, totalRecipients: true },
      });
      emitToNumber(message.conversation.whatsappNumberId, "campaign.progress", { campaignId: r.campaignId, ...updated });
    }
  }

  // On failure, Meta puts the reason in statusEntry.errors — log it loudly so a
  // FAILED status is actually diagnosable (code + title + details), instead of a
  // bare "status → FAILED" that tells you nothing about why delivery failed.
  if (status === "failed" && Array.isArray(statusEntry.errors) && statusEntry.errors.length) {
    const err = statusEntry.errors[0];
    const details = err.error_data?.details || err.message || "";
    console.error(
      `Webhook: message ${whatsappMessageId} FAILED — code ${err.code} (${err.title})` +
      (details ? ` — ${details}` : "") +
      (err.href ? ` [${err.href}]` : ""),
    );
  } else {
    console.log(`Webhook: message ${whatsappMessageId} status → ${mapped}`);
  }
  emitToNumber(message.conversation.whatsappNumberId, "message.status_updated", {
    messageId: message.id,
    status: mapped,
  });
};

const handleReaction = async (value) => {
  const msg = value?.messages?.[0];
  if (!msg || msg.type !== "reaction") return;

  const { message_id: targetWaId, emoji } = msg.reaction;

  const target = await prisma.message.findFirst({
    where: { whatsappMessageId: targetWaId },
    include: { conversation: { select: { whatsappNumberId: true } } },
  });
  if (!target) {
    console.log("Webhook: reaction target not found, skipping");
    return;
  }

  // reactions stored as { "👍": count, "❤️": count, ... }
  const reactions = (target.reactions && typeof target.reactions === "object") ? { ...target.reactions } : {};

  if (emoji) {
    reactions[emoji] = (reactions[emoji] || 0) + 1;
    console.log(`Webhook: reaction ${emoji} on message ${target.id}`);
  } else {
    // Empty emoji = customer removed their reaction — no per-sender tracking, so skip decrement
    console.log(`Webhook: reaction removed on message ${target.id} (skipped)`);
  }

  await prisma.message.update({ where: { id: target.id }, data: { reactions } });
  emitToNumber(target.conversation.whatsappNumberId, "message.reaction", {
    messageId: target.id,
    reactions,
  });
};

// WhatsApp opt-out compliance: honor STOP/START style keywords from customers.
const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "QUIT", "END"]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP", "SUBSCRIBE", "RESUME"]);
const detectOptIntent = (content) => {
  const word = (content || "").trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(word)) return "OUT";
  if (OPT_IN_KEYWORDS.has(word)) return "IN";
  return null;
};

const receiveWhatsAppMessage = async (req, res) => {
  // Return 200 immediately — Meta requires a fast response or it will retry
  res.sendStatus(200);

  // Meta can batch several entries/changes into one delivery. Each is handled
  // on its own, in order, as a single-change payload — the shape the rest of
  // this file expects.
  for (const entry of req.body?.entry || []) {
    for (const change of entry?.changes || []) {
      await processChangePayload({ ...req.body, entry: [{ ...entry, changes: [change] }] });
    }
  }
};

const processChangePayload = async (body) => {
  try {
    const change = body?.entry?.[0]?.changes?.[0];
    const value = change?.value;

    // Meta approved/rejected a template: record it and notify the app.
    if (change?.field === "message_template_status_update") {
      await handleTemplateStatusWebhook(value);
      return;
    }
    // Customer stopped/resumed "Offers and announcements" in WhatsApp.
    if (change?.field === "user_preferences") {
      await handleUserPreferences(value);
      return;
    }

    if (value?.statuses?.length) {
      await handleStatusUpdate(value);
      return;
    }

    // Reaction webhooks: type === "reaction" inside messages array
    if (value?.messages?.[0]?.type === "reaction") {
      await handleReaction(value);
      return;
    }

    const extracted = extractFromPayload(body);
    if (!extracted) {
      console.log("Webhook: no message extracted from payload — skipping");
      return;
    }

    const { phoneNumberId, phone, name, content, mediaId, messageType, rawType, isRecognized, whatsappMessageId, quotedWhatsappMessageId, replyId, buttonPayload } = extracted;

    // Route to the line that received the message. Note the handler already
    // returned 200 at the top of this function — every failure path below is
    // retry-safe by construction, and must NOT become a non-200 response or
    // Meta would retry it forever.
    const number = await numbers.getByPhoneNumberId(phoneNumberId);
    if (!number) {
      const last = unknownNumberSeen.get(phoneNumberId) || 0;
      if (Date.now() - last > UNKNOWN_NUMBER_LOG_INTERVAL_MS) {
        unknownNumberSeen.set(phoneNumberId, Date.now());
        console.warn(
          `Webhook: message for UNKNOWN phone_number_id ${phoneNumberId} - ignored. ` +
          "Add it with: npm run seed:numbers, or unsubscribe it in the Meta app.",
        );
        // Deliberately not auto-creating a WhatsAppNumber row: that would turn a
        // typo or a stray subscription into a silent config change.
        await prisma.auditLog
          .create({
            data: {
              action: "WEBHOOK_UNKNOWN_NUMBER",
              targetType: "WhatsAppNumber",
              targetId: 0,
              details: { phoneNumberId, from: phone },
            },
          })
          .catch(() => {});
      }
      return;
    }
    console.log("Webhook: processing inbound message | type:", messageType, "| rawType:", rawType);

    // Diagnostic: when Meta sends a type we don't cleanly recognize, log the full
    // raw message so we can see its exact shape and add proper handling. This is
    // what makes an "[unsupported: ...]" / uncaptured-media case debuggable —
    // the payload is otherwise not stored anywhere.
    if (!isRecognized) {
      const rawMsg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      console.warn("Webhook: UNRECOGNIZED message type '" + rawType + "' — raw payload:", JSON.stringify(rawMsg));
    }

    // Deduplicate: if we already saved this WhatsApp message ID, skip it
    if (whatsappMessageId) {
      const duplicate = await prisma.message.findFirst({ where: { whatsappMessageId } });
      if (duplicate) {
        console.log("Webhook: duplicate message ignored, id:", whatsappMessageId);
        return;
      }
    }

    // Use upsert to avoid race condition when two webhooks arrive simultaneously for the same customer
    const customer = await prisma.customer.upsert({
      where: { phone },
      update: name ? { name } : {},
      create: { phone, name },
    });
    console.log("Webhook: customer id", customer.id);

    // Honor opt-out / opt-in keywords (STOP / START, etc.) from the customer.
    // Consent is recorded against the number that received the keyword. A STOP
    // to the marketing line must not silence clinic appointment reminders.
    // (Customer.optedOut remains a separate, global do-not-contact switch.)
    const optIntent = messageType === "TEXT" ? detectOptIntent(content) : null;
    if (optIntent === "OUT") {
      await prisma.customerOptOut.upsert({
        where: { customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: number.id } },
        update: {},
        create: { customerId: customer.id, whatsappNumberId: number.id, source: "KEYWORD" },
      });
      console.log("Webhook: customer", customer.id, "opted OUT of", number.label);
    } else if (optIntent === "IN") {
      await prisma.customerOptOut.deleteMany({
        where: { customerId: customer.id, whatsappNumberId: number.id },
      });
      console.log("Webhook: customer", customer.id, "opted IN to", number.label);
    }

    // Use upsert to avoid race condition when creating conversation
    const conversation = await prisma.conversation.upsert({
      where: {
        customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: number.id },
      },
      update: {},
      create: { customerId: customer.id, whatsappNumberId: number.id },
    });
    console.log("Webhook: conversation id", conversation.id);

    // Resolve quoted message: look up by WA ID to get our local DB id
    let quotedMessageId = null;
    if (quotedWhatsappMessageId) {
      const quoted = await prisma.message.findFirst({ where: { whatsappMessageId: quotedWhatsappMessageId } });
      quotedMessageId = quoted?.id ?? null;
    }

    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: "CUSTOMER",
        senderId: null,
        content,
        messageType,
        mediaId,
        whatsappMessageId,
        quotedMessageId,
        status: null,
      },
    });
    console.log("Webhook: saved message id", message.id, quotedMessageId ? `(reply to ${quotedMessageId})` : "");

    // Is this answering a campaign? Never allowed to break message intake: the
    // message is already saved, and attribution is only a link on top of it.
    let campaignReply = null;
    try {
      campaignReply = await attributeReply({
        messageId: message.id,
        customerId: customer.id,
        whatsappNumberId: number.id,
        quotedWhatsappMessageId,
      });
      if (campaignReply) {
        // So the live bubble shows its "Reply to <campaign>" tag straight away.
        message.campaignRecipientId = campaignReply.recipientId;
        message.campaignRecipient = { campaign: campaignReply.campaign };
        console.log(`Webhook: message ${message.id} answers campaign ${campaignReply.campaign.id} (${campaignReply.via})`);
        emitToNumber(number.id, "campaign.replied", {
          campaignId: campaignReply.campaign.id,
          conversationId: conversation.id,
          messageId: message.id,
        });
      }
    } catch (err) {
      console.error("Webhook: campaign attribution failed (message kept):", err.message);
    }

    // Fire-and-forget: upload media to storage in background
    if (mediaId) {
      uploadReceivedMedia(message.id, mediaId, messageType, number.id);
    }

    // A patient writing to a chat marked Resolved reopens it, so a new question
    // can never sit unseen in the resolved pile.
    const reopening = conversation.status === "RESOLVED";

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessage: content,
        lastMessageAt: new Date(),
        lastSenderType: "CUSTOMER",
        lastCustomerMessageAt: new Date(),
        ...(reopening ? { status: "OPEN" } : {}),
      },
    });

    if (reopening) {
      emitToNumber(number.id, "conversation.status_changed", { conversationId: conversation.id, status: "OPEN" });
      logAudit({
        action: "conversation.status_changed",
        actor: null,
        targetType: "conversation",
        targetId: conversation.id,
        details: { status: "OPEN", previousStatus: "RESOLVED", reason: "customer replied" },
      });
    }

    emitToNumber(number.id, "message.created", { message, conversationId: conversation.id });
    emitToNumber(number.id, "conversation.updated", { conversationId: conversation.id });

    // Campaign automation. After the message is saved and shown, so a flow
    // problem can never lose or delay the customer's message; handleInbound
    // catches its own errors.
    flowEngine.handleInbound({
      numberId: number.id,
      customer,
      conversation,
      inbound: { rawType, content, replyId, buttonPayload, whatsappMessageId },
      campaignReply,
      optIntent,
    });
    console.log("Webhook: done ✓");
  } catch (err) {
    console.error("=== WEBHOOK PROCESSING ERROR ===");
    console.error(err);
  }
};

module.exports = { verifyWebhook, receiveWhatsAppMessage };
