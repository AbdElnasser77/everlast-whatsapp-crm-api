const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { sendWhatsAppMessage } = require("../../utils/whatsappClient");
const { fetchAndStoreMedia } = require("../../utils/whatsappMedia");
const { emitToNumber } = require("../../utils/socket");
const { claimIfUnassigned } = require("../../utils/conversationAssignment");
const { windowState, windowClosedError } = require("../../utils/messagingWindow");
const numbers = require("../../utils/whatsappNumbers");
const { handOffOnAgentReply } = require("../../utils/flowEngine");

const sendMessage = async (req, res, next) => {
  try {
    const { conversationId, content, messageType = "TEXT", mediaUrl = null, quotedMessageId } = req.body;

    if (!conversationId) return next(new AppError("conversationId is required", 400));
    if (messageType === "TEXT" && !content) return next(new AppError("content is required for text messages", 400));
    if (messageType !== "TEXT" && !mediaUrl) return next(new AppError("mediaUrl is required for media messages", 400));

    const conversation = await prisma.conversation.findUnique({
      where: { id: parseInt(conversationId) },
      include: { customer: { select: { phone: true } } },
    });
    if (!conversation) return next(new AppError("Conversation not found", 404));

    // The number comes from the CONVERSATION, not from the request. A customer
    // who wrote to the clinic line must be answered on the clinic line — sending
    // the reply from whichever number the agent happens to have selected would
    // start a second thread on the customer's phone.
    if (conversation.whatsappNumberId !== req.numberId) {
      return next(
        new AppError(
          "This conversation belongs to a different WhatsApp number — switch to it to reply",
          409,
          "NUMBER_MISMATCH",
        ),
      );
    }
    const credentials = await numbers.getCredentials(conversation.whatsappNumberId);

    // Free-form messages only inside the 24-hour window — and a contact who has
    // never written is OUTSIDE it (see utils/messagingWindow.js). That case used
    // to be let through, and Meta then rejected the send.
    if (!windowState(conversation.lastCustomerMessageAt).open) {
      return next(windowClosedError(conversation.lastCustomerMessageAt));
    }

    const messageContent = content || mediaUrl;

    let quotedWhatsappMessageId = null;
    if (quotedMessageId) {
      const quoted = await prisma.message.findUnique({
        where: { id: parseInt(quotedMessageId) },
        select: { whatsappMessageId: true },
      });
      quotedWhatsappMessageId = quoted?.whatsappMessageId ?? null;
    }

    let message = await prisma.message.create({
      data: {
        conversationId: parseInt(conversationId),
        senderType: "AGENT",
        senderId: parseInt(req.user.id),
        content: messageContent,
        messageType,
        mediaId: null,
        mediaUrl: mediaUrl || null,
        whatsappMessageId: null,
        status: "PENDING",
        ...(quotedMessageId ? { quotedMessageId: parseInt(quotedMessageId) } : {}),
      },
      include: {
        quotedMessage: {
          select: { id: true, content: true, messageType: true, senderType: true, mediaUrl: true, deletedAt: true },
        },
      },
    });

    try {
      const { whatsappMessageId } = await sendWhatsAppMessage({
        number: credentials,
        to: conversation.customer.phone,
        content,
        messageType,
        mediaUrl,
        quotedWhatsappMessageId,
      });
      message = await prisma.message.update({
        where: { id: message.id },
        data: { whatsappMessageId, status: "SENT" },
        include: {
          quotedMessage: {
            select: { id: true, content: true, messageType: true, senderType: true, mediaUrl: true, deletedAt: true },
          },
        },
      });
    } catch (waErr) {
      const errDetail = waErr.response?.data || waErr.message;
      console.error("WhatsApp send failed:", JSON.stringify(errDetail));
      message = await prisma.message.update({
        where: { id: message.id },
        data: { status: "FAILED" },
        include: {
          quotedMessage: {
            select: { id: true, content: true, messageType: true, senderType: true, mediaUrl: true, deletedAt: true },
          },
        },
      });
    }

    await prisma.conversation.update({
      where: { id: parseInt(conversationId) },
      data: {
        lastMessage: messageContent,
        lastMessageAt: new Date(),
        lastSenderType: "AGENT",
      },
    });

    // Replying to an unassigned chat takes it, so it leaves the Unassigned queue
    // and nobody else picks it up too. Only on a successful send: a failed send
    // shouldn't quietly take ownership.
    if (message.status === "SENT") {
      await claimIfUnassigned({ conversationId: parseInt(conversationId), numberId: conversation.whatsappNumberId, user: req.user });
      // A person is talking now: any flow in this chat steps aside.
      await handOffOnAgentReply(parseInt(conversationId));
    }

    emitToNumber(conversation.whatsappNumberId, "message.created", { message, conversationId: parseInt(conversationId) });
    emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId: parseInt(conversationId) });

    res.status(201).json({ success: true, data: message });
  } catch (err) {
    next(err);
  }
};

const searchMessages = async (req, res, next) => {
  try {
    const { q, conversationId } = req.query;
    if (!q) return next(new AppError("Search query (q) is required", 400));

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Message has no number column of its own — it reaches one through its
    // conversation, which keeps the largest table in the schema normalized.
    const where = {
      content: { contains: q, mode: "insensitive" },
      conversation: { whatsappNumberId: req.numberId },
    };
    if (conversationId) where.conversationId = parseInt(conversationId);

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: messages,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

const getMessageMedia = async (req, res, next) => {
  try {
    const message = await prisma.message.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { conversation: { select: { whatsappNumberId: true } } },
    });

    // Without this check, anyone could fetch another number's media by guessing
    // a message id — the ids are global integers.
    if (!message || message.conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Message not found", 404));
    }
    if (!message.mediaId && !message.mediaUrl) return next(new AppError("This message has no media", 404));

    // Already stored — redirect straight to the permanent storage URL.
    if (message.mediaUrl) {
      return res.redirect(message.mediaUrl);
    }

    // Not stored yet (background upload failed, or hasn't finished). Re-download
    // from Meta by the stored mediaId AND persist it, so this both serves the
    // file now and permanently self-heals the message for every future view.
    try {
      const { buffer, mimetype } = await fetchAndStoreMedia({
        messageId: message.id,
        mediaId: message.mediaId,
        messageType: message.messageType,
        whatsappNumberId: message.conversation.whatsappNumberId,
      });
      res.setHeader("Content-Type", mimetype || "application/octet-stream");
      res.setHeader("Cache-Control", "private, max-age=3600");
      return res.send(buffer);
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error(`getMessageMedia: recover failed for message ${message.id}:`, JSON.stringify(detail));
      // Meta only retains media for a limited window; once it's purged the
      // mediaId no longer resolves and the file is unrecoverable.
      return next(new AppError("Media is no longer available from WhatsApp", 502));
    }
  } catch (err) {
    next(err);
  }
};

// Soft-delete only — WhatsApp's Cloud API has no "unsend" endpoint, so this
// removes the message from the CRM's view but cannot recall it from the
// customer's phone. Agents may only delete their own sent messages; customer
// messages are never eligible, regardless of who's asking.
const deleteMessage = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const message = await prisma.message.findUnique({
      where: { id },
      select: {
        id: true, conversationId: true, senderType: true, senderId: true, deletedAt: true,
        conversation: { select: { whatsappNumberId: true } },
      },
    });
    if (!message || message.conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Message not found", 404));
    }
    if (message.senderType !== "AGENT") {
      return next(new AppError("Customer messages cannot be deleted", 403));
    }
    if (String(message.senderId) !== String(req.user.id)) {
      return next(new AppError("You can only delete your own messages", 403));
    }

    if (!message.deletedAt) {
      await prisma.message.update({
        where: { id },
        data: { deletedAt: new Date(), content: "", mediaUrl: null, mediaId: null },
      });
      emitToNumber(message.conversation.whatsappNumberId, "message.deleted", {
        messageId: id,
        conversationId: message.conversationId,
      });
    }

    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports = { sendMessage, searchMessages, getMessageMedia, deleteMessage };
