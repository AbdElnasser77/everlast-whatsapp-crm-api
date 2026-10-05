const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { emitToNumber } = require("../../utils/socket");
const logAudit = require("../../utils/audit");
const { ASSIGNEE_SELECT, isAssignable } = require("../../utils/conversationAssignment");

const VALID_STATUSES = ["OPEN", "PENDING", "RESOLVED"];

// The inbox's work queues. Each is a list of work still to do, so each leaves
// out RESOLVED chats; "all" is the unfiltered list. Defined once, and used by
// both the list and the tab counts, so a tab's number always matches what
// clicking it shows.
const NOT_RESOLVED = { status: { not: "RESOLVED" } };
const VIEWS = {
  all: () => ({}),
  mine: (req) => ({ assignedAgentId: req.user.id, ...NOT_RESOLVED }),
  unassigned: () => ({ assignedAgentId: null, ...NOT_RESOLVED }),
  // Has at least one message that answers a campaign (see the attribution rule
  // in modules/webhooks/webhook.controller.js).
  campaign_replies: () => ({ messages: { some: { campaignRecipientId: { not: null } } }, ...NOT_RESOLVED }),
};

const getAllConversations = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    // Every conversation query is scoped to the active number. Without this the
    // inbox would merge every line into one list.
    const view = req.query.view || "all";
    if (!VIEWS[view]) {
      return next(new AppError(`view must be one of: ${Object.keys(VIEWS).join(", ")}`, 400));
    }
    const where = { whatsappNumberId: req.numberId, ...VIEWS[view](req) };
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) {
        return next(new AppError(`status must be one of: ${VALID_STATUSES.join(", ")}`, 400));
      }
      where.status = req.query.status;
    }
    if (req.query.assignedAgentId) {
      const id = Number(req.query.assignedAgentId);
      if (!Number.isInteger(id)) return next(new AppError("assignedAgentId must be a user id", 400));
      where.assignedAgentId = id;
    }
    if (req.query.lastSenderType) where.lastSenderType = req.query.lastSenderType;
    // Server-side search — the sidebar only ever loads a page at a time, so
    // filtering client-side would miss any customer outside that window.
    if (req.query.search) {
      const search = String(req.query.search).trim();
      where.customer = {
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { phone: { contains: search } },
        ],
      };
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          customer: { select: { name: true, phone: true } },
          assignedAgent: { select: ASSIGNEE_SELECT },
        },
        // Postgres puts NULL first in a plain DESC sort — without `nulls:
        // "last"`, every conversation that never actually got a message
        // (e.g. a campaign recipient whose send failed before ever writing
        // lastMessageAt) would rank above every real, active conversation.
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        skip,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: conversations,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// The numbers on the inbox's view tabs. One count per view, over the same
// definitions the list uses.
const getConversationCounts = async (req, res, next) => {
  try {
    const entries = await Promise.all(
      ["mine", "unassigned", "campaign_replies"].map(async (view) => [
        view,
        await prisma.conversation.count({ where: { whatsappNumberId: req.numberId, ...VIEWS[view](req) } }),
      ]),
    );
    res.status(200).json({ success: true, data: Object.fromEntries(entries) });
  } catch (err) {
    next(err);
  }
};

const getConversationMessages = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id);
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    // 404 rather than 403 when it belongs to another number: treating it as
    // nonexistent avoids confirming that it exists on a line the caller isn't on.
    if (!conversation || conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId },
        include: {
          // Which campaign this message answers, if any — drives the
          // "Reply to <campaign>" tag on the bubble.
          campaignRecipient: { select: { campaign: { select: { id: true, name: true } } } },
          quotedMessage: {
            select: { id: true, content: true, messageType: true, senderType: true, mediaUrl: true, deletedAt: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.message.count({ where: { conversationId } }),
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

const markConversationRead = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.conversation.findUnique({
      where: { id },
      select: { whatsappNumberId: true },
    });
    if (!existing || existing.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }

    const conversation = await prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });

    emitToNumber(existing.whatsappNumberId, "conversation.updated", { conversationId: id });

    res.status(200).json({ success: true, data: conversation });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Conversation not found", 404));
    next(err);
  }
};

const assignConversation = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id);
    const { agentId } = req.body;

    // null / missing / "" / 0 all mean "unassign". Anything else must be a real
    // integer id — "abc" used to reach Prisma as NaN and surface as a 500.
    const unassign = agentId === null || agentId === undefined || agentId === "" || agentId === 0;
    const targetId = unassign ? null : Number(agentId);
    if (!unassign && !Number.isInteger(targetId)) {
      return next(new AppError("agentId must be a user id, or null to unassign", 400));
    }

    const existing = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        whatsappNumberId: true,
        assignedAgentId: true,
        assignedAgent: { select: ASSIGNEE_SELECT },
      },
    });
    if (!existing || existing.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }

    if (targetId !== null) {
      const agent = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, role: true, isActive: true },
      });
      if (!agent) return next(new AppError("Agent not found", 404));
      // Only someone who can actually work the conversation: an active account
      // whose role can reply. Previously any user row was accepted, including
      // deactivated accounts and read-only marketing users.
      if (!isAssignable(agent)) {
        return next(new AppError("That user can't be assigned conversations", 400, "NOT_ASSIGNABLE"));
      }
    }

    const include = {
      customer: { select: { name: true, phone: true } },
      assignedAgent: { select: ASSIGNEE_SELECT },
    };

    // Re-assigning the current owner changes nothing, so it emits and audits
    // nothing either.
    if (existing.assignedAgentId === targetId) {
      const unchanged = await prisma.conversation.findUnique({ where: { id: conversationId }, include });
      return res.status(200).json({ success: true, data: unchanged });
    }

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { assignedAgentId: targetId },
      include,
    });

    emitToNumber(req.numberId, "conversation.assigned", {
      conversationId,
      agentId: conversation.assignedAgentId,
      agentUsername: conversation.assignedAgent?.username || null,
    });
    // So list views (Mine / Unassigned) re-evaluate whether this row still belongs.
    emitToNumber(req.numberId, "conversation.updated", { conversationId });

    logAudit({
      action: "conversation.assigned",
      actor: req.user,
      targetType: "conversation",
      targetId: conversationId,
      details: {
        agentId: conversation.assignedAgentId,
        agentUsername: conversation.assignedAgent?.username || null,
        previousAgentId: existing.assignedAgentId,
        previousAgentUsername: existing.assignedAgent?.username || null,
      },
    });

    res.status(200).json({ success: true, data: conversation });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Conversation not found", 404));
    next(err);
  }
};

const changeConversationStatus = async (req, res, next) => {
  try {
    const conversationId = parseInt(req.params.id);
    const { status } = req.body;

    if (!status || !VALID_STATUSES.includes(status)) {
      return next(new AppError(`Status must be one of: ${VALID_STATUSES.join(", ")}`, 400));
    }

    const owner = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { whatsappNumberId: true, status: true },
    });
    if (!owner || owner.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }

    const include = {
      customer: { select: { name: true, phone: true } },
      assignedAgent: { select: ASSIGNEE_SELECT },
    };

    // Setting the status it already has changes nothing: no emit, no audit.
    if (owner.status === status) {
      const unchanged = await prisma.conversation.findUnique({ where: { id: conversationId }, include });
      return res.status(200).json({ success: true, data: unchanged });
    }

    const conversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { status },
      include: {
        customer: { select: { name: true, phone: true } },
        assignedAgent: { select: ASSIGNEE_SELECT },
      },
    });

    emitToNumber(req.numberId, "conversation.status_changed", { conversationId, status });
    // So list views re-evaluate — a resolved chat leaves the Unassigned queue.
    emitToNumber(req.numberId, "conversation.updated", { conversationId });

    logAudit({
      action: "conversation.status_changed",
      actor: req.user,
      targetType: "conversation",
      targetId: conversationId,
      details: { status, previousStatus: owner.status },
    });

    res.status(200).json({ success: true, data: conversation });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Conversation not found", 404));
    next(err);
  }
};

const createOrGetConversation = async (req, res, next) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return next(new AppError("customerId is required", 400));

    const customer = await prisma.customer.findUnique({ where: { id: parseInt(customerId) } });
    if (!customer || customer.isActive === false) return next(new AppError("Customer not found", 404));

    // One conversation per (customer, number) — a customer talking to two of our
    // lines has two independent threads, each with its own 24-hour window.
    const existing = await prisma.conversation.findUnique({
      where: {
        customerId_whatsappNumberId: {
          customerId: parseInt(customerId),
          whatsappNumberId: req.numberId,
        },
      },
      include: {
        customer: { select: { name: true, phone: true } },
        assignedAgent: { select: ASSIGNEE_SELECT },
      },
    });
    if (existing) return res.status(200).json({ success: true, data: existing, created: false });

    // Create fresh conversation
    const conversation = await prisma.conversation.create({
      data: {
        customerId: parseInt(customerId),
        whatsappNumberId: req.numberId,
        status: "OPEN",
        unreadCount: 0,
      },
      include: {
        customer: { select: { name: true, phone: true } },
        assignedAgent: { select: ASSIGNEE_SELECT },
      },
    });

    emitToNumber(req.numberId, "conversation.created", { conversationId: conversation.id });

    logAudit({
      action: "conversation.created",
      actor: req.user,
      targetType: "conversation",
      targetId: conversation.id,
      details: { customerId: conversation.customerId, whatsappNumberId: req.numberId, initiatedBy: "agent" },
    });

    res.status(201).json({ success: true, data: conversation, created: true });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getAllConversations,
  getConversationCounts,
  getConversationMessages,
  markConversationRead,
  assignConversation,
  changeConversationStatus,
  createOrGetConversation,
};
