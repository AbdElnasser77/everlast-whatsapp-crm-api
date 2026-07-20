const prisma = require("../../config/prisma");
const storage = require("../../utils/storage");
const { fetchAndStoreMediaWithRetry } = require("../../utils/whatsappMedia");
const { getIO } = require("../../utils/socket");

// Fire-and-forget download of an incoming media message. Retries a few times so
// a single transient failure doesn't strand the file — and even if all retries
// fail, the message keeps its mediaId, so opening it later re-downloads it
// on demand (see getMessageMedia).
const uploadReceivedMedia = async (messageId, mediaId, messageType) => {
  try {
    await fetchAndStoreMediaWithRetry({ messageId, mediaId, messageType });
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
    phone,
    name,
    content,
    mediaId,
    messageType,
    rawType,
    isRecognized: Boolean(mappedType),
    whatsappMessageId: msg.id,
    quotedWhatsappMessageId,
  };
};

const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.send(challenge);
  }
  res.sendStatus(403);
};

const STATUS_MAP = {
  sent: "SENT",
  delivered: "DELIVERED",
  read: "READ",
  failed: "FAILED",
};

const handleStatusUpdate = async (value) => {
  const statusEntry = value?.statuses?.[0];
  if (!statusEntry) return;

  const { id: whatsappMessageId, status } = statusEntry;
  const mapped = STATUS_MAP[status];
  if (!mapped) return;

  const message = await prisma.message.findFirst({ where: { whatsappMessageId } });
  if (!message) return;

  await prisma.message.update({
    where: { id: message.id },
    data: { status: mapped },
  });

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
  getIO().emit("message.status_updated", { messageId: message.id, status: mapped });
};

const handleReaction = async (value) => {
  const msg = value?.messages?.[0];
  if (!msg || msg.type !== "reaction") return;

  const { message_id: targetWaId, emoji } = msg.reaction;

  const target = await prisma.message.findFirst({ where: { whatsappMessageId: targetWaId } });
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
  getIO().emit("message.reaction", { messageId: target.id, reactions });
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

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    if (value?.statuses?.length) {
      await handleStatusUpdate(value);
      return;
    }

    // Reaction webhooks: type === "reaction" inside messages array
    if (value?.messages?.[0]?.type === "reaction") {
      await handleReaction(value);
      return;
    }

    const extracted = extractFromPayload(req.body);
    if (!extracted) {
      console.log("Webhook: no message extracted from payload — skipping");
      return;
    }

    const { phone, name, content, mediaId, messageType, rawType, isRecognized, whatsappMessageId, quotedWhatsappMessageId } = extracted;
    console.log("Webhook: processing inbound message | type:", messageType, "| rawType:", rawType);

    // Diagnostic: when Meta sends a type we don't cleanly recognize, log the full
    // raw message so we can see its exact shape and add proper handling. This is
    // what makes an "[unsupported: ...]" / uncaptured-media case debuggable —
    // the payload is otherwise not stored anywhere.
    if (!isRecognized) {
      const rawMsg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
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
    const optIntent = messageType === "TEXT" ? detectOptIntent(content) : null;
    if (optIntent === "OUT" && !customer.optedOut) {
      await prisma.customer.update({ where: { id: customer.id }, data: { optedOut: true } });
      console.log("Webhook: customer", customer.id, "opted OUT via keyword");
    } else if (optIntent === "IN" && customer.optedOut) {
      await prisma.customer.update({ where: { id: customer.id }, data: { optedOut: false } });
      console.log("Webhook: customer", customer.id, "opted IN via keyword");
    }

    // Use upsert to avoid race condition when creating conversation
    const conversation = await prisma.conversation.upsert({
      where: { customerId: customer.id },
      update: {},
      create: { customerId: customer.id },
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

    // Fire-and-forget: upload media to storage in background
    if (mediaId) {
      uploadReceivedMedia(message.id, mediaId, messageType);
    }

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        unreadCount: { increment: 1 },
        lastMessage: content,
        lastMessageAt: new Date(),
        lastSenderType: "CUSTOMER",
        lastCustomerMessageAt: new Date(),
      },
    });

    const io = getIO();
    io.emit("message.created", { message, conversationId: conversation.id });
    io.emit("conversation.updated", { conversationId: conversation.id });
    console.log("Webhook: done ✓");
  } catch (err) {
    console.error("=== WEBHOOK PROCESSING ERROR ===");
    console.error(err);
  }
};

module.exports = { verifyWebhook, receiveWhatsAppMessage };
