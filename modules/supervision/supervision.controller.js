const { Prisma } = require("@prisma/client");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { workingMinutesBetween } = require("../../utils/workingTime");
const { getQuietHoursConfig, localMinuteOfDay } = require("../../utils/quietHours");

// The Supervision page: how every agent and every chat is doing, across all
// WhatsApp numbers (a supervisor manages the whole team, whichever line a
// patient wrote to). Pass ?numberId= to narrow to one line.

// A patient waiting this long (working time) for a reply is "no follow-up".
const SLA_MINUTES = 30;
// A wait older than this has "gone cold": the patient wrote long ago and
// nobody answered. Shown on its own tab so it doesn't bury today's chats.
const RECENT_MS = 24 * 60 * 60 * 1000;
// Flow runs idle this long without finishing count as dropped halfway.
const STALLED_FLOW_MS = 60 * 60 * 1000;
// The answers a booking flow saves (see ContactPanel "Booking requests").
// A flow run keeps its collected answers under data.answers.
const BOOKING_KEYS = ["preferred_date", "contact_number"];
const answersOf = (data) => (data && typeof data === "object" && data.answers && typeof data.answers === "object" ? data.answers : {});

const PERSON = { select: { id: true, name: true, username: true } };

// Midnight today in the clinic's time zone.
function startOfLocalDay(now = new Date()) {
  const { timezone } = getQuietHoursConfig();
  const m = localMinuteOfDay(now, timezone);
  const startOfMinute = Math.floor(now.getTime() / 60000) * 60000;
  return new Date(startOfMinute - m * 60000);
}

const numberFilter = (req) => {
  const id = parseInt(req.query.numberId);
  return Number.isInteger(id) ? { whatsappNumberId: id } : {};
};

const hasBookingAnswers = (data) => BOOKING_KEYS.some((k) => answersOf(data)[k]);

const flowState = (run, now = Date.now()) => {
  if (!run) return null;
  const stalled = run.status === "ACTIVE" && now - new Date(run.updatedAt).getTime() > STALLED_FLOW_MS;
  return {
    id: run.id,
    flowName: run.flow?.name || null,
    status: stalled ? "STALLED" : run.status,
    // Dropped = left before finishing and wasn't handed to the team.
    droppedHalfway: stalled || run.status === "EXPIRED" || run.status === "STOPPED",
    bookingRequested: hasBookingAnswers(run.data),
    answers: answersOf(run.data),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
};

// Each time a patient started waiting (their first message after anyone else
// spoke) since `since`, with the first staff reply after it. Waits the flow
// bot answered first are left out — the bot handled them.
async function responseTimes(since, numberWhere, until = null) {
  const numberId = numberWhere.whatsappNumberId || null;
  const rows = await prisma.$queryRaw`
    WITH m AS (
      SELECT msg.id, msg."conversationId", msg."senderType", msg."createdAt",
             LAG(msg."senderType") OVER (PARTITION BY msg."conversationId" ORDER BY msg."createdAt", msg.id) AS prev
      FROM "Message" msg
      JOIN "Conversation" c ON c.id = msg."conversationId"
      WHERE msg."createdAt" >= ${new Date(since.getTime() - 7 * 24 * 60 * 60 * 1000)}
        AND (${numberId}::int IS NULL OR c."whatsappNumberId" = ${numberId}::int)
    )
    SELECT s."conversationId", s."createdAt" AS "askedAt",
           r."createdAt" AS "repliedAt", r."senderId" AS "agentId", r."senderType" AS "replyType"
    FROM m s
    LEFT JOIN LATERAL (
      SELECT x."createdAt", x."senderId", x."senderType"
      FROM "Message" x
      WHERE x."conversationId" = s."conversationId"
        AND x."createdAt" > s."createdAt"
        AND (x."senderType" = 'BOT' OR (x."senderType" = 'AGENT' AND x."senderId" IS NOT NULL))
      ORDER BY x."createdAt" ASC
      LIMIT 1
    ) r ON TRUE
    WHERE s."senderType" = 'CUSTOMER'
      AND (s.prev IS NULL OR s.prev <> 'CUSTOMER')
      AND s."createdAt" >= ${since}
      AND (${until}::timestamp IS NULL OR s."createdAt" < ${until}::timestamp)`;
  return rows
    .filter((r) => r.replyType !== "BOT")
    .map((r) => ({
      conversationId: r.conversationId,
      askedAt: r.askedAt,
      repliedAt: r.repliedAt,
      agentId: r.agentId,
      minutes: r.repliedAt ? workingMinutesBetween(r.askedAt, r.repliedAt) : null,
    }));
}

const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

// ─── GET /api/supervision/overview ──────────────────────────────────────────
const getOverview = async (req, res, next) => {
  try {
    const now = new Date();
    const today = startOfLocalDay(now);
    const where = numberFilter(req);

    const [waitingChats, bookedToday, followUpsDue, flowRunsToday, agents, assignedOpen, repliesToday, responses, openRequests] = await Promise.all([
      prisma.conversation.findMany({
        where: { ...where, awaitingReplySince: { not: null }, status: { not: "RESOLVED" } },
        select: { id: true, customerId: true, awaitingReplySince: true, assignedAgentId: true },
      }),
      prisma.booking.findMany({
        where: { status: "BOOKED", createdAt: { gte: today }, ...(where.whatsappNumberId ? { whatsappNumberId: where.whatsappNumberId } : {}) },
        select: { id: true, createdById: true },
      }),
      prisma.conversation.count({
        where: { ...where, outcome: "FOLLOW_UP", followUpAt: { lte: new Date(today.getTime() + 24 * 60 * 60 * 1000) } },
      }),
      prisma.flowRun.findMany({
        where: { updatedAt: { gte: today }, ...(where.whatsappNumberId ? { conversation: { whatsappNumberId: where.whatsappNumberId } } : {}) },
        select: { id: true, status: true, data: true, updatedAt: true, conversation: { select: { outcome: true } } },
      }),
      // The team being supervised: agents and supervisors — not admins, and
      // not the person looking (nobody supervises themselves).
      prisma.user.findMany({
        where: { isActive: true, role: { in: ["AGENT", "SUPERVISOR"] }, id: { not: req.user.id } },
        select: { id: true, name: true, username: true, role: true, status: true, lastActiveAt: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      }),
      prisma.conversation.groupBy({
        by: ["assignedAgentId"],
        where: { ...where, assignedAgentId: { not: null }, status: { not: "RESOLVED" } },
        _count: { _all: true },
      }),
      prisma.message.groupBy({
        by: ["senderId"],
        where: { senderType: "AGENT", senderId: { not: null }, createdAt: { gte: today }, ...(where.whatsappNumberId ? { conversation: { whatsappNumberId: where.whatsappNumberId } } : {}) },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      responseTimes(today, where),
      prisma.bookingRequest.findMany({
        where: { status: { in: ["NEW", "IN_PROGRESS"] }, ...(where.whatsappNumberId ? { whatsappNumberId: where.whatsappNumberId } : {}) },
        select: { id: true, status: true, createdAt: true },
      }),
    ]);

    // Today's waits only; a patient on two lines counts once.
    const recentSince = now.getTime() - RECENT_MS;
    const goneCold = new Set(waitingChats.filter((c) => c.awaitingReplySince.getTime() < recentSince).map((c) => c.customerId));
    const waiting = waitingChats
      .filter((c) => c.awaitingReplySince.getTime() >= recentSince)
      .map((c) => ({ ...c, minutes: workingMinutesBetween(c.awaitingReplySince, now) }));
    const patients = (list) => new Set(list.map((c) => c.customerId)).size;
    const overSla = waiting.filter((c) => c.minutes >= SLA_MINUTES);
    const runs = flowRunsToday.map((r) => ({ ...r, state: flowState({ ...r, flow: null }, now.getTime()) }));

    const assignedMap = new Map(assignedOpen.map((g) => [g.assignedAgentId, g._count._all]));
    const repliesMap = new Map(repliesToday.map((g) => [g.senderId, g._count._all]));
    const lastReplyMap = new Map(repliesToday.map((g) => [g.senderId, g._max.createdAt]));
    const answered = responses.filter((r) => r.minutes !== null);

    const board = agents.map((a) => {
      const mine = answered.filter((r) => r.agentId === a.id).map((r) => r.minutes);
      return {
        ...a,
        openChats: assignedMap.get(a.id) || 0,
        waiting: waiting.filter((c) => c.assignedAgentId === a.id).length,
        waitingOverSla: overSla.filter((c) => c.assignedAgentId === a.id).length,
        repliesToday: repliesMap.get(a.id) || 0,
        lastReplyAt: lastReplyMap.get(a.id) || null,
        avgResponseMinutes: avg(mine),
        bookedToday: bookedToday.filter((b) => b.createdById === a.id).length,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        slaMinutes: SLA_MINUTES,
        generatedAt: now,
        kpis: {
          waiting: patients(waiting),
          waitingOverSla: patients(overSla),
          unassignedWaiting: patients(waiting.filter((c) => !c.assignedAgentId)),
          // Waiting over a day: on the "Gone cold" tab, not in the counts above.
          goneCold: goneCold.size,
          longestWaitMinutes: waiting.reduce((m, c) => Math.max(m, c.minutes), 0),
          bookedToday: bookedToday.length,
          bookingRequestsOpen: openRequests.length,
          // Nobody picked them up yet, and those waiting past the target.
          bookingRequestsNew: openRequests.filter((r) => r.status === "NEW").length,
          bookingRequestsOverSla: openRequests.filter((r) => workingMinutesBetween(r.createdAt, now) >= SLA_MINUTES).length,
          droppedHalfwayToday: runs.filter((r) => r.state.droppedHalfway && !r.state.bookingRequested).length,
          flowsStartedToday: runs.length,
          followUpsDue,
          avgFirstResponseMinutes: avg(answered.map((r) => r.minutes)),
          unansweredToday: responses.filter((r) => r.minutes === null).length,
        },
        agents: board,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/conversations ─────────────────────────────────────
// ?filter= waiting | cold | booking | halfway | follow_up | booked | all
// &agentId= <id> | unassigned   &numberId=   &search=   &page=
// One row per PATIENT: if they match on two lines, the newest chat is the row
// and the others ride along in `otherChats`. Pages count patients.
const FILTERS = ["waiting", "cold", "booking", "halfway", "follow_up", "booked", "all"];

const getConversations = async (req, res, next) => {
  try {
    const filter = FILTERS.includes(req.query.filter) ? req.query.filter : "waiting";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const now = new Date();

    const where = { ...numberFilter(req) };
    if (req.query.agentId === "unassigned") where.assignedAgentId = null;
    else if (Number.isInteger(parseInt(req.query.agentId))) where.assignedAgentId = parseInt(req.query.agentId);
    const search = String(req.query.search || "").trim();
    if (search) {
      where.customer = { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search.replace(/^\+/, "") } }] };
    }

    // Newest first, like WhatsApp — the waiting timer shows who is overdue.
    let orderBy = [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }];
    const recentSince = new Date(now.getTime() - RECENT_MS);
    if (filter === "waiting") {
      where.awaitingReplySince = { gte: recentSince };
      where.status = { not: "RESOLVED" };
    } else if (filter === "cold") {
      where.awaitingReplySince = { lt: recentSince };
      where.status = { not: "RESOLVED" };
    } else if (filter === "follow_up") {
      where.outcome = "FOLLOW_UP";
      orderBy = { followUpAt: "asc" };
    } else if (filter === "booked") {
      where.outcome = "BOOKED";
      orderBy = [{ outcomeAt: "desc" }, { id: "desc" }];
    } else if (filter === "booking") {
      // Chats with an open booking request.
      where.bookingRequests = { some: { status: { in: ["NEW", "IN_PROGRESS"] } } };
    } else if (filter === "halfway") {
      // Chats whose latest flow run asked for a booking (or stopped halfway)
      // and that no agent has closed out yet.
      const runs = await prisma.$queryRaw`
        SELECT DISTINCT ON (fr."conversationId") fr."conversationId", fr.status, fr.data, fr."updatedAt"
        FROM "FlowRun" fr
        ORDER BY fr."conversationId", fr."startedAt" DESC`;
      const ids = runs
        .filter((r) => {
          const st = flowState(r, now.getTime());
          return st.droppedHalfway && !st.bookingRequested;
        })
        .map((r) => r.conversationId);
      where.id = { in: ids };
      where.OR = [{ outcome: null }, { outcome: { in: ["FOLLOW_UP", "NO_ANSWER"] } }];
    }

    const matching = await prisma.conversation.findMany({ where, orderBy, select: { id: true, customerId: true }, take: 5000 });
    const order = [];
    const byPatient = new Map();
    for (const m of matching) {
      if (!byPatient.has(m.customerId)) {
        byPatient.set(m.customerId, []);
        order.push(m.customerId);
      }
      byPatient.get(m.customerId).push(m.id);
    }
    const total = order.length;
    const pagePatients = order.slice((page - 1) * limit, page * limit);
    const ids = pagePatients.flatMap((c) => byPatient.get(c));

    const [fetched] = await Promise.all([
      prisma.conversation.findMany({
        where: { id: { in: ids } },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          whatsappNumber: { select: { id: true, label: true } },
          assignedAgent: PERSON,
          outcomeBy: PERSON,
          flowRuns: { orderBy: { startedAt: "desc" }, take: 1, include: { flow: { select: { name: true } } } },
          bookings: { orderBy: { createdAt: "desc" }, take: 1 },
          bookingRequests: { where: { status: { in: ["NEW", "IN_PROGRESS"] } }, orderBy: { createdAt: "desc" }, take: 1, include: { claimedBy: PERSON } },
          _count: { select: { notes: true } },
        },
      }),
    ]);
    const rowById = new Map(fetched.map((c) => [c.id, c]));

    const toRow = (c) => {
      const waitingMinutes = c.awaitingReplySince && c.status !== "RESOLVED" ? workingMinutesBetween(c.awaitingReplySince, now) : null;
      return {
        id: c.id,
        customer: c.customer,
        whatsappNumber: c.whatsappNumber,
        assignedAgent: c.assignedAgent,
        status: c.status,
        lastMessage: c.lastMessage,
        lastMessageAt: c.lastMessageAt,
        lastSenderType: c.lastSenderType,
        lastAgentReplyAt: c.lastAgentReplyAt,
        awaitingReplySince: c.awaitingReplySince,
        waitingMinutes,
        overSla: waitingMinutes !== null && waitingMinutes >= SLA_MINUTES,
        outcome: c.outcome,
        outcomeAt: c.outcomeAt,
        outcomeBy: c.outcomeBy,
        followUpAt: c.followUpAt,
        followUpOverdue: c.outcome === "FOLLOW_UP" && c.followUpAt && c.followUpAt <= now,
        flow: flowState(c.flowRuns[0], now.getTime()),
        latestBooking: c.bookings[0] || null,
        openRequest: c.bookingRequests[0] || null,
        noteCount: c._count.notes,
      };
    };
    const data = pagePatients.map((customerId) => {
      const [first, ...rest] = byPatient.get(customerId).map((id) => toRow(rowById.get(id)));
      return {
        ...first,
        // The same patient's other chats in this list (other lines).
        otherChats: rest.map((o) => ({
          id: o.id,
          whatsappNumber: o.whatsappNumber,
          lastMessage: o.lastMessage,
          lastMessageAt: o.lastMessageAt,
          lastSenderType: o.lastSenderType,
          waitingMinutes: o.waitingMinutes,
          overSla: o.overSla,
          outcome: o.outcome,
          assignedAgent: o.assignedAgent,
        })),
      };
    });

    res.status(200).json({
      success: true,
      data,
      slaMinutes: SLA_MINUTES,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/conversations/:id ─────────────────────────────────
// Everything about one chat for the side panel: latest messages, when the
// patient waited and how long each reply took, flow progress, outcome,
// bookings, notes, assignment history.
const getConversationTimeline = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const now = new Date();
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, phone: true, tags: true, optedOut: true } },
        whatsappNumber: { select: { id: true, label: true } },
        assignedAgent: PERSON,
        outcomeBy: PERSON,
        bookings: { orderBy: { createdAt: "desc" }, include: { createdBy: PERSON } },
        bookingRequests: {
          orderBy: { createdAt: "desc" },
          include: { campaign: { select: { id: true, name: true } }, claimedBy: PERSON, handledBy: PERSON, bookings: { orderBy: { appointmentAt: "asc" } } },
        },
        notes: { orderBy: { createdAt: "desc" }, include: { author: PERSON } },
        flowRuns: { orderBy: { startedAt: "desc" }, take: 5, include: { flow: { select: { name: true } } } },
      },
    });
    if (!conversation) return next(new AppError("Conversation not found", 404));

    const messages = (
      await prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "desc" },
        take: 60,
        select: { id: true, senderType: true, content: true, messageType: true, mediaUrl: true, status: true, createdAt: true, sender: PERSON },
      })
    ).reverse();

    // How long each wait lasted, from the messages shown.
    const waits = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.senderType !== "CUSTOMER" || (i > 0 && messages[i - 1].senderType === "CUSTOMER")) continue;
      const reply = messages.slice(i + 1).find((x) => x.senderType === "BOT" || (x.senderType === "AGENT" && x.sender));
      waits.push({
        askedAt: m.createdAt,
        repliedAt: reply ? reply.createdAt : null,
        repliedBy: reply ? (reply.senderType === "BOT" ? "Flow" : reply.sender?.name || reply.sender?.username) : null,
        minutes: workingMinutesBetween(m.createdAt, reply ? reply.createdAt : now),
        stillWaiting: !reply,
      });
    }

    // The same patient on other lines, so a supervisor sees the whole picture.
    const otherChats = (
      await prisma.conversation.findMany({
        where: { customerId: conversation.customerId, id: { not: id } },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        select: {
          id: true, status: true, lastMessage: true, lastMessageAt: true, lastSenderType: true,
          awaitingReplySince: true, outcome: true,
          whatsappNumber: { select: { id: true, label: true } },
          assignedAgent: PERSON,
        },
      })
    ).map((o) => {
      const waiting = o.awaitingReplySince && o.status !== "RESOLVED" ? workingMinutesBetween(o.awaitingReplySince, now) : null;
      return { ...o, waitingMinutes: waiting, overSla: waiting !== null && waiting >= SLA_MINUTES };
    });

    const history = await prisma.auditLog.findMany({
      where: { targetType: "conversation", targetId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { action: true, actorUsername: true, details: true, createdAt: true },
    });

    const waitingMinutes =
      conversation.awaitingReplySince && conversation.status !== "RESOLVED" ? workingMinutesBetween(conversation.awaitingReplySince, now) : null;

    res.status(200).json({
      success: true,
      data: {
        ...conversation,
        flowRuns: conversation.flowRuns.map((r) => flowState(r, now.getTime())),
        waitingMinutes,
        overSla: waitingMinutes !== null && waitingMinutes >= SLA_MINUTES,
        messages,
        otherChats,
        waits: waits.reverse(),
        history,
        slaMinutes: SLA_MINUTES,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/bookings ──────────────────────────────────────────
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (appointment dates; default today → +30d)
// &agentId= &status=BOOKED|CANCELLED|all &numberId=
const getBookings = async (req, res, next) => {
  try {
    const parseDay = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null);
    const today = startOfLocalDay();
    const from = parseDay(req.query.from) || today;
    const to = parseDay(req.query.to) ? new Date(parseDay(req.query.to).getTime() + 24 * 60 * 60 * 1000) : new Date(today.getTime() + 31 * 24 * 60 * 60 * 1000);
    const where = { appointmentAt: { gte: from, lt: to } };
    if (req.query.status !== "all") where.status = req.query.status === "CANCELLED" ? "CANCELLED" : "BOOKED";
    if (Number.isInteger(parseInt(req.query.agentId))) where.createdById = parseInt(req.query.agentId);
    if (Number.isInteger(parseInt(req.query.numberId))) where.whatsappNumberId = parseInt(req.query.numberId);

    const data = await prisma.booking.findMany({
      where,
      orderBy: { appointmentAt: "asc" },
      take: 500,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        createdBy: PERSON,
        conversation: { select: { id: true, whatsappNumberId: true } },
      },
    });
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/activity ──────────────────────────────────────────
// The live feed for the full-screen dashboard: what agents said, who wrote in,
// hand-offs, assignments, outcomes and bookings — newest first.
// ?after=<ISO> returns only what happened since (the page polls with it);
// ?limit= (default 40, max 100); ?numberId= narrows to one line.
const FEED_ACTIONS = [
  "conversation.assigned",
  "conversation.claimed",
  "conversation.status_changed",
  "conversation.outcome_set",
  "conversation.booking_cancelled",
  "flow.handed_off",
  "booking_request.created",
  "booking_request.booked",
  "booking_request.not_booked",
];

// One line of text for a message: templates and interactive messages store
// JSON; media shows as a label.
function messageText(m) {
  const media = { IMAGE: "📷 Photo", VIDEO: "🎥 Video", AUDIO: "🎤 Voice note", DOCUMENT: "📄 Document", STICKER: "Sticker", LOCATION: "📍 Location" };
  if (media[m.messageType]) return m.content && !String(m.content).startsWith("{") ? `${media[m.messageType]} · ${m.content}` : media[m.messageType];
  const raw = String(m.content || "");
  if (raw.startsWith("{")) {
    try {
      const p = JSON.parse(raw);
      return p.body || p.text || p.header || "Template message";
    } catch {
      // not JSON after all
    }
  }
  return raw;
}

const getActivity = async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 40));
    const after = req.query.after && !Number.isNaN(new Date(req.query.after).getTime()) ? new Date(req.query.after) : null;
    const lineId = Number.isInteger(parseInt(req.query.numberId)) ? parseInt(req.query.numberId) : null;
    const since = after ? { gt: after } : { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };

    const [messages, events] = await Promise.all([
      prisma.message.findMany({
        where: {
          createdAt: since,
          deletedAt: null,
          // Patients, and people on the team — not campaign sends or the bot.
          OR: [{ senderType: "CUSTOMER" }, { senderType: "AGENT", senderId: { not: null } }],
          ...(lineId ? { conversation: { whatsappNumberId: lineId } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true, senderType: true, content: true, messageType: true, createdAt: true,
          sender: PERSON,
          conversation: {
            select: {
              id: true,
              customer: { select: { id: true, name: true, phone: true } },
              whatsappNumber: { select: { id: true, label: true } },
            },
          },
        },
      }),
      prisma.auditLog.findMany({
        where: { targetType: "conversation", action: { in: FEED_ACTIONS }, createdAt: since },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, action: true, actorId: true, actorUsername: true, details: true, targetId: true, createdAt: true },
      }),
    ]);

    // The chats the events are about (name, line), in one query.
    const convIds = [...new Set(events.map((e) => e.targetId))];
    const convs = convIds.length
      ? await prisma.conversation.findMany({
          where: { id: { in: convIds }, ...(lineId ? { whatsappNumberId: lineId } : {}) },
          select: { id: true, customer: { select: { id: true, name: true, phone: true } }, whatsappNumber: { select: { id: true, label: true } } },
        })
      : [];
    const convById = new Map(convs.map((c) => [c.id, c]));
    const actorIds = [...new Set(events.map((e) => e.actorId).filter(Boolean))];
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, username: true } }) : [];
    const actorById = new Map(actors.map((a) => [a.id, a]));

    const items = [
      ...messages.map((m) => ({
        id: `m${m.id}`,
        type: m.senderType === "CUSTOMER" ? "patient_message" : "agent_message",
        at: m.createdAt,
        actor: m.senderType === "CUSTOMER" ? null : m.sender,
        conversationId: m.conversation.id,
        customer: m.conversation.customer,
        line: m.conversation.whatsappNumber,
        text: messageText(m).slice(0, 300),
        details: null,
      })),
      ...events
        .filter((e) => convById.has(e.targetId))
        .map((e) => {
          const c = convById.get(e.targetId);
          return {
            id: `a${e.id}`,
            type: e.action,
            at: e.createdAt,
            actor: e.actorId ? actorById.get(e.actorId) || { id: e.actorId, name: null, username: e.actorUsername } : null,
            conversationId: c.id,
            customer: c.customer,
            line: c.whatsappNumber,
            text: null,
            details: e.details || null,
          };
        }),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, limit);

    res.status(200).json({ success: true, data: items, serverTime: new Date() });
  } catch (err) {
    next(err);
  }
};

module.exports = { getOverview, getConversations, getConversationTimeline, getBookings, getActivity, SLA_MINUTES, startOfLocalDay, responseTimes, messageText, _flowState: flowState };
