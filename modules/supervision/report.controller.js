const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { workingMinutesBetween } = require("../../utils/workingTime");
const { getQuietHoursConfig, localMinuteOfDay } = require("../../utils/quietHours");
const { SLA_MINUTES, responseTimes, messageText } = require("./supervision.controller");

// The supervisor's report for a period: team stats, per-agent figures,
// bookings, campaigns and every chat — printed to PDF by the Report page.
// Transcripts are fetched separately, only for the chats the supervisor
// ticks, so a busy month doesn't become a thousand-page download.

const PERSON = { select: { id: true, name: true, username: true } };
const DAY = 24 * 60 * 60 * 1000;
const MAX_DAYS = 92;
const MAX_CHATS = 2000;
const MAX_TRANSCRIPTS = 100;
const MAX_MESSAGES_PER_CHAT = 300;

// Midnight of a YYYY-MM-DD day in the clinic's time zone.
function localMidnight(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(guess)) return null;
  const local = localMinuteOfDay(new Date(guess), getQuietHoursConfig().timezone);
  // East of UTC the zone is already into this day; west of it, still the day before.
  return new Date(local <= 720 ? guess - local * 60000 : guess + (1440 - local) * 60000);
}

function readPeriod(req) {
  const from = localMidnight(req.query.from);
  const toDay = localMidnight(req.query.to);
  if (!from || !toDay) throw new AppError("Choose a from and to date (YYYY-MM-DD)", 400);
  const to = new Date(toDay.getTime() + DAY); // the "to" day is included
  if (to <= from) throw new AppError("The end date is before the start date", 400);
  if (to - from > MAX_DAYS * DAY) throw new AppError(`A report can cover at most ${MAX_DAYS} days`, 400);
  const numberId = Number.isInteger(parseInt(req.query.numberId)) ? parseInt(req.query.numberId) : null;
  return { from, to, numberId };
}

const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
const countBy = (list, key) => list.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] || 0) + 1), acc), {});

// ─── GET /api/supervision/report?from=YYYY-MM-DD&to=YYYY-MM-DD&numberId= ────
const getReport = async (req, res, next) => {
  try {
    const { from, to, numberId } = readPeriod(req);
    const inPeriod = { gte: from, lt: to };
    const lineWhere = numberId ? { whatsappNumberId: numberId } : {};
    const msgLine = numberId ? { conversation: { whatsappNumberId: numberId } } : {};

    const [patientMsgs, staffMsgs, waits, requests, bookings, outcomeEvents, users, campaigns, lines] = await Promise.all([
      prisma.message.findMany({ where: { createdAt: inPeriod, senderType: "CUSTOMER", deletedAt: null, ...msgLine }, select: { conversationId: true } }),
      prisma.message.findMany({ where: { createdAt: inPeriod, senderType: "AGENT", senderId: { not: null }, deletedAt: null, ...msgLine }, select: { conversationId: true, senderId: true } }),
      responseTimes(from, lineWhere, to),
      prisma.bookingRequest.findMany({
        where: { createdAt: inPeriod, ...lineWhere },
        select: { id: true, source: true, status: true, notBookedReason: true, handledById: true, campaignId: true, conversationId: true, createdAt: true, handledAt: true },
      }),
      prisma.booking.findMany({
        where: { createdAt: inPeriod, ...lineWhere },
        orderBy: { appointmentAt: "asc" },
        include: { customer: { select: { id: true, name: true, phone: true } }, createdBy: PERSON },
      }),
      prisma.auditLog.findMany({
        where: { action: "conversation.outcome_set", createdAt: inPeriod, targetType: "conversation" },
        select: { actorId: true, details: true, targetId: true },
      }),
      prisma.user.findMany({ where: { role: { in: ["AGENT", "SUPERVISOR", "ADMIN"] } }, select: { id: true, name: true, username: true, role: true, isActive: true } }),
      prisma.campaign.findMany({
        where: { deletedAt: null, startedAt: inPeriod, ...lineWhere },
        select: { id: true, name: true, status: true, startedAt: true, totalRecipients: true, sentCount: true, failedCount: true, whatsappNumber: { select: { label: true } } },
        orderBy: { startedAt: "asc" },
      }),
      prisma.whatsAppNumber.findMany({ select: { id: true, label: true } }),
    ]);

    // Campaign figures: replies, requests and bookings they produced.
    const campaignIds = campaigns.map((c) => c.id);
    const [replied, campRequests, campBooked] = campaignIds.length
      ? await Promise.all([
          prisma.campaignRecipient.groupBy({ by: ["campaignId"], where: { campaignId: { in: campaignIds }, repliedAt: { not: null } }, _count: { _all: true } }),
          prisma.bookingRequest.groupBy({ by: ["campaignId"], where: { campaignId: { in: campaignIds } }, _count: { _all: true } }),
          prisma.booking.groupBy({ by: ["campaignId"], where: { campaignId: { in: campaignIds }, status: "BOOKED" }, _count: { _all: true } }),
        ])
      : [[], [], []];
    const byCampaign = (rows) => new Map(rows.map((r) => [r.campaignId, r._count._all]));
    const repliedMap = byCampaign(replied), reqMap = byCampaign(campRequests), bookedMap = byCampaign(campBooked);
    const campaignNames = new Map(
      (await prisma.campaign.findMany({ where: { id: { in: [...new Set(bookings.map((b) => b.campaignId).filter(Boolean))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
    );

    // Outcome events limited to this line, if one was chosen.
    let outcomeEventsInScope = outcomeEvents;
    if (numberId) {
      const ok = new Set((await prisma.conversation.findMany({ where: { id: { in: [...new Set(outcomeEvents.map((e) => e.targetId))] }, whatsappNumberId: numberId }, select: { id: true } })).map((c) => c.id));
      outcomeEventsInScope = outcomeEvents.filter((e) => ok.has(e.targetId));
    }

    const answered = waits.filter((w) => w.minutes !== null);
    const late = answered.filter((w) => w.minutes >= SLA_MINUTES);
    const liveBookings = bookings.filter((b) => b.status === "BOOKED");

    // ── per agent ──
    const agents = users
      .map((u) => {
        const mine = answered.filter((w) => w.agentId === u.id);
        const replies = staffMsgs.filter((m) => m.senderId === u.id);
        return {
          id: u.id,
          name: u.name,
          username: u.username,
          role: u.role,
          isActive: u.isActive,
          chats: new Set(replies.map((m) => m.conversationId)).size,
          replies: replies.length,
          firstResponses: mine.length,
          avgResponseMinutes: avg(mine.map((w) => w.minutes)),
          lateResponses: mine.filter((w) => w.minutes >= SLA_MINUTES).length,
          appointmentsBooked: liveBookings.filter((b) => b.createdById === u.id).length,
          requestsBooked: requests.filter((r) => r.status === "BOOKED" && r.handledById === u.id).length,
          requestsNotBooked: requests.filter((r) => r.status === "NOT_BOOKED" && r.handledById === u.id).length,
          outcomesSet: outcomeEventsInScope.filter((e) => e.actorId === u.id).length,
        };
      })
      .filter((a) => a.replies || a.appointmentsBooked || a.requestsBooked || a.requestsNotBooked || a.outcomesSet)
      .sort((a, b) => b.replies - a.replies);

    // ── chats: every conversation with a message in the period ──
    const activeIds = [...new Set([...patientMsgs, ...staffMsgs].map((m) => m.conversationId))];
    const truncated = activeIds.length > MAX_CHATS;
    const convs = await prisma.conversation.findMany({
      where: { id: { in: activeIds.slice(0, MAX_CHATS) } },
      orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
      select: {
        id: true, status: true, outcome: true, lastMessageAt: true, awaitingReplySince: true,
        customer: { select: { id: true, name: true, phone: true } },
        whatsappNumberId: true,
        assignedAgent: PERSON,
        bookingRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, notBookedReason: true } },
      },
    });
    const lineLabel = new Map(lines.map((l) => [l.id, l.label]));
    const msgCount = countBy([...patientMsgs, ...staffMsgs], (m) => m.conversationId);
    const patientCount = countBy(patientMsgs, (m) => m.conversationId);
    const chats = convs.map((c) => {
      const w = waits.filter((x) => x.conversationId === c.id);
      const done = w.filter((x) => x.minutes !== null);
      return {
        id: c.id,
        customer: c.customer,
        line: lineLabel.get(c.whatsappNumberId) || null,
        assignedAgent: c.assignedAgent,
        status: c.status,
        outcome: c.outcome,
        request: c.bookingRequests[0] || null,
        messages: msgCount[c.id] || 0,
        patientMessages: patientCount[c.id] || 0,
        avgResponseMinutes: avg(done.map((x) => x.minutes)),
        lateResponses: done.filter((x) => x.minutes >= SLA_MINUTES).length,
        unanswered: w.some((x) => x.minutes === null),
        lastMessageAt: c.lastMessageAt,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        period: { from, to, fromDay: req.query.from, toDay: req.query.to, timezone: getQuietHoursConfig().timezone },
        line: numberId ? { id: numberId, label: lineLabel.get(numberId) || null } : null,
        generatedAt: new Date(),
        slaMinutes: SLA_MINUTES,
        summary: {
          chats: activeIds.length,
          patientsWrote: new Set(patientMsgs.map((m) => m.conversationId)).size,
          patientMessages: patientMsgs.length,
          staffReplies: staffMsgs.length,
          firstResponses: answered.length,
          avgFirstResponseMinutes: avg(answered.map((w) => w.minutes)),
          withinSlaPercent: answered.length ? Math.round(((answered.length - late.length) / answered.length) * 100) : null,
          lateResponses: late.length,
          unanswered: waits.length - answered.length,
          bookingRequests: requests.length,
          bookingRequestsBySource: countBy(requests, (r) => r.source),
          requestsBooked: requests.filter((r) => r.status === "BOOKED").length,
          requestsNotBooked: requests.filter((r) => r.status === "NOT_BOOKED").length,
          requestsStillOpen: requests.filter((r) => r.status === "NEW" || r.status === "IN_PROGRESS").length,
          notBookedReasons: countBy(requests.filter((r) => r.status === "NOT_BOOKED"), (r) => r.notBookedReason || "OTHER"),
          appointmentsBooked: liveBookings.length,
          // Where the booked patients came from (confirmed or proven only).
          bookingsByLeadSource: countBy(liveBookings, (b) => b.leadSource || "UNKNOWN"),
          appointmentsCancelled: bookings.length - liveBookings.length,
          outcomes: countBy(outcomeEventsInScope, (e) => (e.details && e.details.outcome) || "CLEARED"),
        },
        agents,
        bookings: bookings.map((b) => ({
          id: b.id,
          customer: b.customer,
          service: b.service,
          appointmentAt: b.appointmentAt,
          doctor: b.doctor,
          dok32Ref: b.dok32Ref,
          note: b.note,
          status: b.status,
          bookedBy: b.createdBy,
          bookedAt: b.createdAt,
          campaign: b.campaignId ? campaignNames.get(b.campaignId) || null : null,
          leadSource: b.leadSource || null,
          conversationId: b.conversationId,
        })),
        campaigns: campaigns.map((c) => ({
          id: c.id,
          name: c.name,
          line: c.whatsappNumber?.label || null,
          status: c.status,
          startedAt: c.startedAt,
          recipients: c.totalRecipients,
          sent: c.sentCount,
          failed: c.failedCount,
          replied: repliedMap.get(c.id) || 0,
          bookingRequests: reqMap.get(c.id) || 0,
          booked: bookedMap.get(c.id) || 0,
        })),
        chats,
        chatsTruncated: truncated,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/report/transcripts?ids=1,2,3&from=&to= ────────────
// The messages of the chosen chats within the period, oldest first.
const getTranscripts = async (req, res, next) => {
  try {
    const { from, to } = readPeriod(req);
    const ids = [...new Set(String(req.query.ids || "").split(",").map((x) => parseInt(x)).filter(Number.isInteger))];
    if (ids.length === 0) return next(new AppError("Choose at least one chat", 400));
    if (ids.length > MAX_TRANSCRIPTS) return next(new AppError(`At most ${MAX_TRANSCRIPTS} transcripts in one report`, 400));

    const convs = await prisma.conversation.findMany({
      where: { id: { in: ids } },
      select: { id: true, customer: { select: { name: true, phone: true } }, whatsappNumber: { select: { label: true } }, assignedAgent: PERSON },
    });
    const data = [];
    for (const c of convs) {
      const messages = await prisma.message.findMany({
        where: { conversationId: c.id, createdAt: { gte: from, lt: to }, deletedAt: null },
        orderBy: { createdAt: "asc" },
        take: MAX_MESSAGES_PER_CHAT + 1,
        select: { id: true, senderType: true, content: true, messageType: true, createdAt: true, sender: PERSON },
      });
      data.push({
        id: c.id,
        customer: c.customer,
        line: c.whatsappNumber?.label || null,
        assignedAgent: c.assignedAgent,
        truncated: messages.length > MAX_MESSAGES_PER_CHAT,
        messages: messages.slice(0, MAX_MESSAGES_PER_CHAT).map((m) => ({
          id: m.id,
          from: m.senderType === "CUSTOMER" ? "patient" : m.senderType === "BOT" ? "bot" : m.sender ? "agent" : "campaign",
          sender: m.sender ? m.sender.name || m.sender.username : null,
          text: messageText(m),
          at: m.createdAt,
        })),
      });
    }
    // Keep the order the supervisor asked for.
    data.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    res.status(200).json({ success: true, data });
  } catch (err) {
    next(err);
  }
};

module.exports = { getReport, getTranscripts, localMidnight, readPeriod };
