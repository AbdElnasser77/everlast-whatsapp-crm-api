const prisma = require("../../config/prisma");
const { Prisma } = require("@prisma/client");
const {
  conversationWhere,
  messageWhere,
  sqlNumberFilter,
  sqlConversationJoin,
  scopeMeta,
} = require("./stats.scope");

const toNum = (val) => (typeof val === "bigint" ? Number(val) : val);

const fmtDate = (val) =>
  val instanceof Date ? val.toISOString().split("T")[0] : String(val);

// ─── GET /api/stats/overview ─────────────────────────────────────────────────
const getOverview = async (req, res, next) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      messagesToday,
      messagesLast7Days,
      convByStatus,
      unassignedCount,
      totalCustomers,
      newCustomers,
      agentsByStatus,
      unreadAgg,
      unreadChats,
    ] = await Promise.all([
      prisma.message.count({ where: { createdAt: { gte: todayStart }, ...messageWhere(req) } }),
      prisma.message.count({ where: { createdAt: { gte: sevenDaysAgo }, ...messageWhere(req) } }),
      prisma.conversation.groupBy({ by: ["status"], where: conversationWhere(req), _count: { id: true } }),
      prisma.conversation.count({
        where: { assignedAgentId: null, status: { not: "RESOLVED" }, ...conversationWhere(req) },
      }),
      // Customer and agent figures stay GLOBAL. A customer is one person
      // regardless of which line they wrote to, and agent presence is not a
      // property of a phone number. The response's `meta.scope` is what lets the
      // dashboard label these honestly rather than implying they follow the
      // switcher.
      prisma.customer.count(),
      prisma.customer.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.user.groupBy({ by: ["status"], where: { role: "AGENT" }, _count: { id: true } }),
      prisma.conversation.aggregate({ where: conversationWhere(req), _sum: { unreadCount: true } }),
      // Chats with anything unread — what the Inbox badge shows, like WhatsApp
      // (one chat with five new messages is one, not five).
      prisma.conversation.count({ where: { ...conversationWhere(req), unreadCount: { gt: 0 } } }),
    ]);

    const conv = { OPEN: 0, PENDING: 0, RESOLVED: 0 };
    convByStatus.forEach(({ status, _count }) => { conv[status] = _count.id; });

    const agent = { ONLINE: 0, OFFLINE: 0, ON_BREAK: 0 };
    agentsByStatus.forEach(({ status, _count }) => { agent[status] = _count.id; });

    res.status(200).json({
      success: true,
      // Tells the dashboard which figures follow the number switcher and which
      // are account-wide, so global customer/agent counts can be labelled as such.
      meta: scopeMeta(req),
      data: {
        messages: { today: messagesToday, last7Days: messagesLast7Days },
        conversations: {
          open: conv.OPEN,
          pending: conv.PENDING,
          resolved: conv.RESOLVED,
          unassigned: unassignedCount,
          total: conv.OPEN + conv.PENDING + conv.RESOLVED,
        },
        customers: { total: totalCustomers, newLast7Days: newCustomers },
        agents: { online: agent.ONLINE, onBreak: agent.ON_BREAK, offline: agent.OFFLINE },
        unreadMessages: unreadAgg._sum.unreadCount || 0,
        unreadConversations: unreadChats,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/stats/messages?days=7 ──────────────────────────────────────────
const getMessageStats = async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 7));
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [chartRaw, typeGroups, statusGroups, peakRaw] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('day', m."createdAt")::date AS date,
          SUM(CASE WHEN m."senderType" = 'CUSTOMER' THEN 1 ELSE 0 END)::int AS incoming,
          SUM(CASE WHEN m."senderType" = 'AGENT'    THEN 1 ELSE 0 END)::int AS outgoing
        FROM "Message" m
        ${sqlConversationJoin("conv", "m")}
        WHERE m."createdAt" >= ${startDate}
        ${sqlNumberFilter(req, "conv")}
        GROUP BY date
        ORDER BY date ASC
      `,
      prisma.message.groupBy({
        by: ["messageType"],
        where: { createdAt: { gte: startDate }, ...messageWhere(req) },
        _count: { id: true },
      }),
      prisma.message.groupBy({
        by: ["status"],
        where: {
          createdAt: { gte: startDate },
          senderType: "AGENT",
          status: { not: null },
          ...messageWhere(req),
        },
        _count: { id: true },
      }),
      prisma.$queryRaw`
        SELECT EXTRACT(HOUR FROM m."createdAt")::int AS hour, COUNT(*)::int AS count
        FROM "Message" m
        ${sqlConversationJoin("conv", "m")}
        WHERE m."createdAt" >= ${startDate}
        ${sqlNumberFilter(req, "conv")}
        GROUP BY hour
        ORDER BY count DESC
        LIMIT 1
      `,
    ]);

    const typeBreakdown = {};
    typeGroups.forEach(({ messageType, _count }) => { typeBreakdown[messageType] = _count.id; });

    const statusBreakdown = {};
    statusGroups.forEach(({ status, _count }) => { if (status) statusBreakdown[status] = _count.id; });

    res.status(200).json({
      success: true,
      // Tells the dashboard which figures follow the number switcher and which
      // are account-wide, so global customer/agent counts can be labelled as such.
      meta: scopeMeta(req),
      data: {
        chart: chartRaw.map((r) => ({
          date: fmtDate(r.date),
          incoming: toNum(r.incoming),
          outgoing: toNum(r.outgoing),
        })),
        typeBreakdown,
        statusBreakdown,
        peakHour: peakRaw[0] ? toNum(peakRaw[0].hour) : null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/stats/conversations ────────────────────────────────────────────
const getConversationStats = async (req, res, next) => {
  try {
    const sevenDaysAgo   = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const fortyEightHAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const sixHoursAgo    = new Date(Date.now() - 6  * 60 * 60 * 1000);
    const now            = Date.now();

    const [pipeline, avgResRaw, newLast7Raw, leads, stalled] = await Promise.all([
      prisma.conversation.groupBy({ by: ["status"], where: conversationWhere(req), _count: { id: true } }),
      prisma.$queryRaw`
        SELECT AVG(EXTRACT(EPOCH FROM (conv."updatedAt" - conv."createdAt")) / 3600) AS avg_hours
        FROM "Conversation" conv
        WHERE conv.status = 'RESOLVED'
        ${sqlNumberFilter(req, "conv")}
      `,
      prisma.$queryRaw`
        SELECT DATE_TRUNC('day', conv."createdAt")::date AS date, COUNT(*)::int AS count
        FROM "Conversation" conv
        WHERE conv."createdAt" >= ${sevenDaysAgo}
        ${sqlNumberFilter(req, "conv")}
        GROUP BY date
        ORDER BY date ASC
      `,
      // Potential leads: unassigned, customer waiting, still fresh (<48h)
      prisma.conversation.findMany({
        where: {
          status: "OPEN",
          assignedAgentId: null,
          lastSenderType: "CUSTOMER",
          lastMessageAt: { gte: fortyEightHAgo },
          ...conversationWhere(req),
        },
        include: { customer: { select: { name: true, phone: true, tags: true } } },
        orderBy: { lastMessageAt: "desc" },
        take: 20,
      }),
      // Stalled: agent assigned but no reply for 6+ hours
      prisma.conversation.findMany({
        where: {
          status: { not: "RESOLVED" },
          lastSenderType: "CUSTOMER",
          lastMessageAt: { lt: sixHoursAgo },
          ...conversationWhere(req),
        },
        include: {
          customer: { select: { name: true, phone: true } },
          assignedAgent: { select: { username: true } },
        },
        orderBy: { lastMessageAt: "asc" },
        take: 20,
      }),
    ]);

    const pipelineMap = { OPEN: 0, PENDING: 0, RESOLVED: 0 };
    pipeline.forEach(({ status, _count }) => { pipelineMap[status] = _count.id; });

    const avgResolutionHours = avgResRaw[0]?.avg_hours
      ? parseFloat(Number(avgResRaw[0].avg_hours).toFixed(1))
      : null;

    res.status(200).json({
      success: true,
      // Tells the dashboard which figures follow the number switcher and which
      // are account-wide, so global customer/agent counts can be labelled as such.
      meta: scopeMeta(req),
      data: {
        pipeline: pipelineMap,
        avgResolutionHours,
        newLast7Days: newLast7Raw.map((r) => ({
          date: fmtDate(r.date),
          count: toNum(r.count),
        })),
        potentialLeads: leads.map((c) => ({
          conversationId: c.id,
          customerId: c.customerId,
          customerName: c.customer.name,
          customerPhone: c.customer.phone,
          tags: c.customer.tags,
          lastMessageAt: c.lastMessageAt,
          waitingHours: c.lastMessageAt
            ? parseFloat(((now - new Date(c.lastMessageAt).getTime()) / 3600000).toFixed(1))
            : null,
          unreadCount: c.unreadCount,
        })),
        stalledConversations: stalled.map((c) => ({
          conversationId: c.id,
          customerId: c.customerId,
          customerName: c.customer.name,
          customerPhone: c.customer.phone,
          assignedAgent: c.assignedAgent?.username || null,
          lastMessageAt: c.lastMessageAt,
          waitingHours: c.lastMessageAt
            ? parseFloat(((now - new Date(c.lastMessageAt).getTime()) / 3600000).toFixed(1))
            : null,
          status: c.status,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/stats/agents ────────────────────────────────────────────────────
const getAgentStats = async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [agents, msgCounts, avgResponseRaw, openConvCounts, assignedCounts] = await Promise.all([
      prisma.user.findMany({
        where: { role: "AGENT" },
        select: {
          id: true,
          name: true,
          username: true,
          status: true,
          lastActiveAt: true,
        },
        orderBy: { username: "asc" },
      }),
      prisma.message.groupBy({
        by: ["senderId"],
        where: {
          senderType: "AGENT",
          createdAt: { gte: sevenDaysAgo },
          senderId: { not: null },
          ...messageWhere(req),
        },
        _count: { id: true },
      }),
      // Average time (in minutes) between a customer message and the next agent reply
      // The number filter removes whole conversations rather than splitting the
      // PARTITION BY "conversationId" window, so the LAG pairs stay intact.
      prisma.$queryRaw`
        WITH ordered AS (
          SELECT
            m."senderId",
            m."createdAt"  AS agent_time,
            LAG(m."createdAt")  OVER (PARTITION BY m."conversationId" ORDER BY m."createdAt") AS prev_time,
            LAG(m."senderType") OVER (PARTITION BY m."conversationId" ORDER BY m."createdAt") AS prev_sender
          FROM "Message" m
          ${sqlConversationJoin("conv", "m")}
          WHERE m."createdAt" >= ${sevenDaysAgo}
          ${sqlNumberFilter(req, "conv")}
        )
        SELECT
          "senderId",
          ROUND(AVG(EXTRACT(EPOCH FROM (agent_time - prev_time)) / 60)::numeric, 1) AS avg_minutes
        FROM ordered
        WHERE prev_sender = 'CUSTOMER'
          AND prev_time IS NOT NULL
          AND "senderId" IS NOT NULL
        GROUP BY "senderId"
      `,
      prisma.conversation.groupBy({
        by: ["assignedAgentId"],
        where: { status: "OPEN", assignedAgentId: { not: null }, ...conversationWhere(req) },
        _count: { id: true },
      }),
      // Replaces the relation _count that used to hang off the user query: that
      // one counted assignments across every line and could not be scoped.
      prisma.conversation.groupBy({
        by: ["assignedAgentId"],
        where: { assignedAgentId: { not: null }, ...conversationWhere(req) },
        _count: { id: true },
      }),
    ]);

    const assignedMap = {};
    assignedCounts.forEach(({ assignedAgentId, _count }) => {
      if (assignedAgentId) assignedMap[assignedAgentId] = _count.id;
    });

    const msgMap = {};
    msgCounts.forEach(({ senderId, _count }) => { if (senderId) msgMap[senderId] = _count.id; });

    const responseMap = {};
    avgResponseRaw.forEach((r) => {
      if (r.senderId) responseMap[r.senderId] = r.avg_minutes != null ? parseFloat(Number(r.avg_minutes)) : null;
    });

    const openConvMap = {};
    openConvCounts.forEach(({ assignedAgentId, _count }) => {
      if (assignedAgentId) openConvMap[assignedAgentId] = _count.id;
    });

    const statusSummary = { ONLINE: 0, ON_BREAK: 0, OFFLINE: 0 };
    agents.forEach(({ status }) => { statusSummary[status] = (statusSummary[status] || 0) + 1; });

    res.status(200).json({
      success: true,
      // Tells the dashboard which figures follow the number switcher and which
      // are account-wide, so global customer/agent counts can be labelled as such.
      meta: scopeMeta(req),
      data: {
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          username: a.username,
          status: a.status,
          lastActiveAt: a.lastActiveAt,
          assignedConversations: assignedMap[a.id] || 0,
          openConversations: openConvMap[a.id] || 0,
          messagesSentLast7Days: msgMap[a.id] || 0,
          avgResponseTimeMinutes: responseMap[a.id] ?? null,
        })),
        statusSummary,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/stats/customers?days=30 ────────────────────────────────────────
const getCustomerStats = async (req, res, next) => {
  try {
    const days         = Math.min(90, Math.max(7, parseInt(req.query.days) || 30));
    const startDate    = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [growthRaw, tagDistRaw, totalCustomers, withEmail, activeCount, returning] =
      await Promise.all([
        prisma.$queryRaw`
          SELECT DATE_TRUNC('day', "createdAt")::date AS date, COUNT(*)::int AS "newCustomers"
          FROM "Customer"
          WHERE "createdAt" >= ${startDate}
          GROUP BY date
          ORDER BY date ASC
        `,
        prisma.$queryRaw`
          SELECT tag, COUNT(*)::int AS count
          FROM "Customer", UNNEST(tags) AS tag
          GROUP BY tag
          ORDER BY count DESC
        `,
        prisma.customer.count(),
        prisma.customer.count({ where: { email: { not: null } } }),
        // Active = had a message in the last 7 days
        prisma.conversation.count({
          where: { lastMessageAt: { gte: sevenDaysAgo }, ...conversationWhere(req) },
        }),
        // Returning = old customer (>30 days) who messaged again recently
        prisma.conversation.findMany({
          where: {
            status: { in: ["OPEN", "PENDING"] },
            lastSenderType: "CUSTOMER",
            lastMessageAt: { gte: sevenDaysAgo },
            customer: { createdAt: { lt: thirtyDaysAgo } },
            ...conversationWhere(req),
          },
          include: {
            customer: { select: { id: true, name: true, phone: true, tags: true } },
            _count: { select: { messages: true } },
          },
          orderBy: { lastMessageAt: "desc" },
          take: 20,
        }),
      ]);

    const emailCaptureRate = totalCustomers > 0
      ? Math.round((withEmail / totalCustomers) * 100)
      : 0;

    res.status(200).json({
      success: true,
      // Tells the dashboard which figures follow the number switcher and which
      // are account-wide, so global customer/agent counts can be labelled as such.
      meta: scopeMeta(req),
      data: {
        growth: growthRaw.map((r) => ({
          date: fmtDate(r.date),
          newCustomers: toNum(r.newCustomers),
        })),
        returningCustomers: returning.map((c) => ({
          id: c.customer.id,
          name: c.customer.name,
          phone: c.customer.phone,
          tags: c.customer.tags,
          conversationStatus: c.status,
          lastMessageAt: c.lastMessageAt,
          totalMessages: c._count.messages,
        })),
        tagDistribution: tagDistRaw.map((r) => ({
          tag: r.tag,
          count: toNum(r.count),
        })),
        emailCaptureRate,
        totalCustomers,
        activeCustomers: activeCount,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getOverview,
  getMessageStats,
  getConversationStats,
  getAgentStats,
  getCustomerStats,
};
