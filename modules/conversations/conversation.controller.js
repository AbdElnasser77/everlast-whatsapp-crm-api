const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { emitToNumber } = require("../../utils/socket");
const logAudit = require("../../utils/audit");
const { ASSIGNEE_SELECT, isAssignable } = require("../../utils/conversationAssignment");
const numbers = require("../../utils/whatsappNumbers");
const { windowState } = require("../../utils/messagingWindow");
const { sendTypingIndicator } = require("../../utils/whatsappClient");

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

// ─── POST /api/conversations/:id/typing ─────────────────────────────────────
// An agent is typing a reply: show "typing…" to the customer on their latest
// message. This also blue-ticks it — WhatsApp offers no typing without read —
// which is why it's only sent while someone is actually writing back, never on
// merely opening the chat. At most once per 20s per chat (it lasts 25s), and
// only inside the 24-hour window, where a reply is possible at all.
const TYPING_REFRESH_MS = 20_000;
const lastTyping = new Map();
const sendConversationTyping = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      select: { whatsappNumberId: true, lastCustomerMessageAt: true },
    });
    if (!conversation || conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }
    const now = Date.now();
    if (now - (lastTyping.get(id) || 0) < TYPING_REFRESH_MS) return res.status(200).json({ success: true, sent: false });
    if (!windowState(conversation.lastCustomerMessageAt).open) return res.status(200).json({ success: true, sent: false });

    const latest = await prisma.message.findFirst({
      where: { conversationId: id, senderType: "CUSTOMER", whatsappMessageId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { whatsappMessageId: true },
    });
    if (!latest) return res.status(200).json({ success: true, sent: false });

    lastTyping.set(id, now);
    try {
      const credentials = await numbers.getCredentials(conversation.whatsappNumberId);
      await sendTypingIndicator({ number: credentials, messageId: latest.whatsappMessageId });
    } catch (err) {
      // Cosmetic: never surface as an error to the agent who's typing.
      console.warn("Typing indicator failed:", err.response?.data?.error?.message || err.message);
      return res.status(200).json({ success: true, sent: false });
    }
    res.status(200).json({ success: true, sent: true });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/conversations/:id/profile ─────────────────────────────────────
// Everything the chat's contact panel shows, in one request: the customer,
// what flows collected from them (booking requests), the chat's media, docs and
// links, and the campaigns they received.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const getConversationProfile = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      select: {
        id: true, whatsappNumberId: true, status: true, createdAt: true, lastCustomerMessageAt: true,
        assignedAgent: { select: ASSIGNEE_SELECT },
        customer: true,
      },
    });
    if (!conversation || conversation.whatsappNumberId !== req.numberId) {
      return next(new AppError("Conversation not found", 404));
    }
    const customerId = conversation.customer.id;
    const notDeleted = { conversationId: id, deletedAt: null };

    const [runs, mediaRows, mediaCounts, linkRows, campaigns, optOut, messageCount] = await Promise.all([
      prisma.flowRun.findMany({
        where: { conversationId: id },
        orderBy: { startedAt: "desc" },
        take: 20,
        select: { id: true, status: true, startedAt: true, completedAt: true, data: true, flow: { select: { id: true, name: true } } },
      }),
      prisma.message.findMany({
        where: { ...notDeleted, messageType: { in: ["IMAGE", "VIDEO", "DOCUMENT", "AUDIO"] } },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { id: true, messageType: true, mediaUrl: true, content: true, senderType: true, createdAt: true },
      }),
      prisma.message.groupBy({
        by: ["messageType"],
        where: { ...notDeleted, messageType: { in: ["IMAGE", "VIDEO", "DOCUMENT", "AUDIO"] } },
        _count: { _all: true },
      }),
      prisma.message.findMany({
        where: { ...notDeleted, content: { contains: "http" } },
        orderBy: { createdAt: "desc" },
        take: 80,
        select: { id: true, content: true, senderType: true, createdAt: true },
      }),
      prisma.campaignRecipient.findMany({
        where: { customerId, status: "SENT", campaign: { whatsappNumberId: conversation.whatsappNumberId } },
        orderBy: { sentAt: "desc" },
        take: 10,
        select: { sentAt: true, repliedAt: true, campaign: { select: { id: true, name: true } } },
      }),
      prisma.customerOptOut.findFirst({
        where: { customerId, whatsappNumberId: conversation.whatsappNumberId },
        select: { optedOutAt: true, source: true },
      }),
      prisma.message.count({ where: notDeleted }),
    ]);

    // Links: every URL a person would see in the chat, newest first, once each.
    // Template/flow messages store JSON; only their visible text and link
    // buttons count — not the image addresses in their headers and cards.
    const visibleText = (content) => {
      try {
        const p = JSON.parse(content);
        if (p && typeof p === "object") {
          const parts = [p.body, p.footer, p.header];
          for (const b of p.buttons || []) if (b && b.url) parts.push(b.url);
          for (const c of p.cards || []) {
            parts.push(c.body);
            for (const b of c.buttons || []) if (b && b.url) parts.push(b.url);
          }
          return parts.filter(Boolean).join("\n");
        }
      } catch {
        // plain text
      }
      return String(content || "");
    };
    const seen = new Set();
    const links = [];
    for (const m of linkRows) {
      for (const url of visibleText(m.content).match(URL_RE) || []) {
        const clean = url.replace(/[.,;:!?]+$/, "");
        if (seen.has(clean)) continue;
        seen.add(clean);
        links.push({ messageId: m.id, url: clean, senderType: m.senderType, createdAt: m.createdAt });
      }
    }

    // What each flow visit collected; the ones with booking details first.
    const responses = runs
      .map((r) => ({
        id: r.id,
        flow: r.flow,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        answers: (r.data && r.data.answers) || {},
      }))
      .filter((r) => Object.keys(r.answers).length > 0);

    res.status(200).json({
      success: true,
      data: {
        customer: conversation.customer,
        conversation: {
          id: conversation.id,
          status: conversation.status,
          createdAt: conversation.createdAt,
          lastCustomerMessageAt: conversation.lastCustomerMessageAt,
          assignedAgent: conversation.assignedAgent,
          messageCount,
        },
        optOut,
        responses,
        media: mediaRows,
        mediaCounts: Object.fromEntries(mediaCounts.map((g) => [g.messageType, g._count._all])),
        links: links.slice(0, 50),
        campaigns: campaigns.map((c) => ({ id: c.campaign.id, name: c.campaign.name, sentAt: c.sentAt, repliedAt: c.repliedAt })),
      },
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
  sendConversationTyping,
  getConversationProfile,
  assignConversation,
  changeConversationStatus,
  createOrGetConversation,
};
