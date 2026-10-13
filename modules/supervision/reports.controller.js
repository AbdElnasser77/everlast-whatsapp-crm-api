const prisma = require("../../config/prisma");
const { workingMinutesBetween } = require("../../utils/workingTime");
const { getQuietHoursConfig, localMinuteOfDay } = require("../../utils/quietHours");
const { SLA_MINUTES, responseTimes } = require("./supervision.controller");
const { readPeriod } = require("./report.controller");

// The separate, detailed reports (Bookings, Team, Campaigns, Chats). Each takes
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (clinic time zone, both days included, max 92
// days) and optional ?numberId=. The overview report and transcripts live in
// report.controller.js.

const PERSON = { select: { id: true, name: true, username: true } };
const who = (u) => (u ? u.name || u.username : null);
const avg = (list) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);
const percentile = (list, p) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const countBy = (list, key) => list.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] || 0) + 1), acc), {});
// Response-time bands for the distribution tables.
const BANDS = [
  { key: "under5", max: 5 },
  { key: "5to15", max: 15 },
  { key: "15to30", max: 30 },
  { key: "30to60", max: 60 },
  { key: "over60", max: Infinity },
];
const bandOf = (m) => BANDS.find((b) => m < b.max).key;
const bands = (list) => Object.fromEntries(BANDS.map((b) => [b.key, list.filter((m) => bandOf(m) === b.key).length]));

const tz = () => getQuietHoursConfig().timezone;
const dayOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz() }).format(new Date(d));
const hourOf = (d) => Math.floor(localMinuteOfDay(new Date(d), tz()) / 60);

const meta = (req, period) => ({
  period: { from: period.from, to: period.to, fromDay: req.query.from, toDay: req.query.to, timezone: tz() },
  numberId: period.numberId,
  generatedAt: new Date(),
  slaMinutes: SLA_MINUTES,
});

// ─── GET /api/supervision/reports/bookings ──────────────────────────────────
// Every booking request opened in the period, or closed in it: what was asked,
// where the patient came from, who took it and how fast, the appointments
// booked, or why it couldn't be booked.
const getBookingsReport = async (req, res, next) => {
  try {
    const period = readPeriod(req);
    const inPeriod = { gte: period.from, lt: period.to };
    const line = period.numberId ? { whatsappNumberId: period.numberId } : {};
    const requests = await prisma.bookingRequest.findMany({
      where: { ...line, OR: [{ createdAt: inPeriod }, { handledAt: inPeriod }] },
      orderBy: { createdAt: "asc" },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        campaign: { select: { id: true, name: true } },
        suggestedCampaign: { select: { id: true, name: true } },
        claimedBy: PERSON,
        handledBy: PERSON,
        bookings: { orderBy: { appointmentAt: "asc" }, include: { createdBy: PERSON } },
      },
    });
    const lines = new Map((await prisma.whatsAppNumber.findMany({ select: { id: true, label: true } })).map((l) => [l.id, l.label]));

    const rows = requests.map((r) => {
      const live = r.bookings.filter((b) => b.status === "BOOKED");
      return {
        id: r.id,
        conversationId: r.conversationId,
        createdAt: r.createdAt,
        customer: r.customer,
        line: lines.get(r.whatsappNumberId) || null,
        openedVia: r.source, // FLOW | AGENT
        requested: r.requested,
        note: r.note,
        leadSource: r.leadSource,
        sourceStatus: r.sourceStatus,
        campaign: r.campaign?.name || null,
        suggestedCampaign: r.suggestedCampaign?.name || null,
        status: r.status,
        claimedBy: who(r.claimedBy),
        claimedAt: r.claimedAt,
        handledBy: who(r.handledBy),
        handledAt: r.handledAt,
        // Working minutes from the request to being picked up / closed.
        minutesToPickUp: r.claimedAt ? workingMinutesBetween(r.createdAt, r.claimedAt) : null,
        minutesToClose: r.handledAt ? workingMinutesBetween(r.createdAt, r.handledAt) : null,
        notBookedReason: r.notBookedReason,
        notBookedNote: r.notBookedNote,
        appointmentsBooked: live.length,
        appointmentsCancelled: r.bookings.length - live.length,
        appointments: r.bookings.map((b) => ({
          id: b.id,
          service: b.service,
          appointmentAt: b.appointmentAt,
          doctor: b.doctor,
          dok32Ref: b.dok32Ref,
          note: b.note,
          status: b.status,
          bookedBy: who(b.createdBy),
          bookedAt: b.createdAt,
        })),
      };
    });

    const closed = rows.filter((r) => r.minutesToClose !== null);
    const byAgent = {};
    for (const r of rows) {
      if (!r.handledBy) continue;
      const a = (byAgent[r.handledBy] ||= { agent: r.handledBy, booked: 0, notBooked: 0, appointments: 0, closeMinutes: [] });
      if (r.status === "BOOKED") a.booked++;
      if (r.status === "NOT_BOOKED") a.notBooked++;
      a.appointments += r.appointmentsBooked;
      if (r.minutesToClose !== null) a.closeMinutes.push(r.minutesToClose);
    }

    res.status(200).json({
      success: true,
      data: {
        ...meta(req, period),
        summary: {
          requests: rows.length,
          byStatus: countBy(rows, (r) => r.status),
          byOpenedVia: countBy(rows, (r) => r.openedVia),
          byLeadSource: countBy(rows, (r) => r.leadSource || (r.sourceStatus === "SUGGESTED" ? "SUGGESTED" : "UNKNOWN")),
          notBookedReasons: countBy(rows.filter((r) => r.status === "NOT_BOOKED"), (r) => r.notBookedReason || "OTHER"),
          appointmentsBooked: rows.reduce((n, r) => n + r.appointmentsBooked, 0),
          appointmentsCancelled: rows.reduce((n, r) => n + r.appointmentsCancelled, 0),
          patientsBooked: new Set(rows.filter((r) => r.appointmentsBooked > 0).map((r) => r.customer.id)).size,
          bookingRate: rows.filter((r) => r.status === "BOOKED" || r.status === "NOT_BOOKED").length
            ? Math.round((rows.filter((r) => r.status === "BOOKED").length / rows.filter((r) => r.status === "BOOKED" || r.status === "NOT_BOOKED").length) * 100)
            : null,
          avgMinutesToPickUp: avg(rows.filter((r) => r.minutesToPickUp !== null).map((r) => r.minutesToPickUp)),
          avgMinutesToClose: avg(closed.map((r) => r.minutesToClose)),
        },
        byAgent: Object.values(byAgent).map((a) => ({ ...a, avgMinutesToClose: avg(a.closeMinutes), closeMinutes: undefined })),
        requests: rows,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/reports/team ──────────────────────────────────────
// How each person on the team did: speed (average, median, slowest 10%,
// bands), volume, outcomes, bookings, notes; plus the team's day-by-day trend
// and the busiest hours (when patients write in).
const getTeamReport = async (req, res, next) => {
  try {
    const period = readPeriod(req);
    const inPeriod = { gte: period.from, lt: period.to };
    const line = period.numberId ? { whatsappNumberId: period.numberId } : {};
    const msgLine = period.numberId ? { conversation: { whatsappNumberId: period.numberId } } : {};

    const [users, staffMsgs, patientMsgs, waits, outcomeEvents, notes, requests, bookings, assignedNow] = await Promise.all([
      prisma.user.findMany({ where: { role: { in: ["AGENT", "SUPERVISOR", "ADMIN"] } }, select: { id: true, name: true, username: true, role: true, isActive: true } }),
      prisma.message.findMany({ where: { createdAt: inPeriod, senderType: "AGENT", senderId: { not: null }, deletedAt: null, ...msgLine }, select: { conversationId: true, senderId: true, createdAt: true } }),
      prisma.message.findMany({ where: { createdAt: inPeriod, senderType: "CUSTOMER", deletedAt: null, ...msgLine }, select: { conversationId: true, createdAt: true } }),
      responseTimes(period.from, line, period.to),
      prisma.auditLog.findMany({ where: { action: "conversation.outcome_set", createdAt: inPeriod, targetType: "conversation" }, select: { actorId: true, details: true, targetId: true } }),
      prisma.conversationNote.findMany({ where: { createdAt: inPeriod, ...(period.numberId ? { conversation: { whatsappNumberId: period.numberId } } : {}) }, select: { authorId: true } }),
      prisma.bookingRequest.findMany({ where: { ...line, OR: [{ claimedAt: inPeriod }, { handledAt: inPeriod }] }, select: { claimedById: true, claimedAt: true, handledById: true, handledAt: true, status: true, createdAt: true } }),
      prisma.booking.findMany({ where: { createdAt: inPeriod, status: "BOOKED", ...line }, select: { createdById: true, customerId: true, createdAt: true } }),
      prisma.conversation.groupBy({ by: ["assignedAgentId"], where: { ...line, assignedAgentId: { not: null }, status: { not: "RESOLVED" } }, _count: { _all: true } }),
    ]);

    let outcomes = outcomeEvents;
    if (period.numberId) {
      const ok = new Set((await prisma.conversation.findMany({ where: { id: { in: [...new Set(outcomeEvents.map((e) => e.targetId))] }, whatsappNumberId: period.numberId }, select: { id: true } })).map((c) => c.id));
      outcomes = outcomeEvents.filter((e) => ok.has(e.targetId));
    }
    const answered = waits.filter((w) => w.minutes !== null);
    const openNow = new Map(assignedNow.map((g) => [g.assignedAgentId, g._count._all]));
    const inRange = (d) => d && d >= period.from && d < period.to;

    const agents = users
      .map((u) => {
        const mine = answered.filter((w) => w.agentId === u.id).map((w) => w.minutes);
        const replies = staffMsgs.filter((m) => m.senderId === u.id);
        const days = new Set(replies.map((m) => dayOf(m.createdAt)));
        const myOutcomes = outcomes.filter((e) => e.actorId === u.id);
        return {
          id: u.id,
          name: u.name,
          username: u.username,
          role: u.role,
          isActive: u.isActive,
          activeDays: days.size,
          chatsHandled: new Set(replies.map((m) => m.conversationId)).size,
          replies: replies.length,
          firstResponses: mine.length,
          avgResponseMinutes: avg(mine),
          medianResponseMinutes: percentile(mine, 50),
          p90ResponseMinutes: percentile(mine, 90),
          withinSlaPercent: mine.length ? Math.round((mine.filter((m) => m < SLA_MINUTES).length / mine.length) * 100) : null,
          lateResponses: mine.filter((m) => m >= SLA_MINUTES).length,
          responseBands: bands(mine),
          outcomes: countBy(myOutcomes, (e) => (e.details && e.details.outcome) || "CLEARED"),
          notesWritten: notes.filter((n) => n.authorId === u.id).length,
          requestsTaken: requests.filter((r) => r.claimedById === u.id && inRange(r.claimedAt)).length,
          requestsBooked: requests.filter((r) => r.handledById === u.id && r.status === "BOOKED" && inRange(r.handledAt)).length,
          requestsNotBooked: requests.filter((r) => r.handledById === u.id && r.status === "NOT_BOOKED" && inRange(r.handledAt)).length,
          appointmentsBooked: bookings.filter((b) => b.createdById === u.id).length,
          patientsBooked: new Set(bookings.filter((b) => b.createdById === u.id).map((b) => b.customerId)).size,
          openChatsNow: openNow.get(u.id) || 0,
        };
      })
      .filter((a) => a.replies || a.firstResponses || a.appointmentsBooked || a.requestsTaken || a.requestsBooked || a.requestsNotBooked || a.notesWritten || Object.keys(a.outcomes).length)
      .sort((a, b) => b.replies - a.replies);

    // Day by day for the whole team.
    const dayKeys = [];
    for (let t = period.from.getTime(); t < period.to.getTime(); t += 24 * 60 * 60 * 1000) dayKeys.push(dayOf(new Date(t + 12 * 60 * 60 * 1000)));
    const daily = [...new Set(dayKeys)].map((day) => {
      const dayWaits = answered.filter((w) => dayOf(w.askedAt) === day).map((w) => w.minutes);
      return {
        day,
        patientMessages: patientMsgs.filter((m) => dayOf(m.createdAt) === day).length,
        chats: new Set([...patientMsgs, ...staffMsgs].filter((m) => dayOf(m.createdAt) === day).map((m) => m.conversationId)).size,
        staffReplies: staffMsgs.filter((m) => dayOf(m.createdAt) === day).length,
        avgFirstResponseMinutes: avg(dayWaits),
        lateResponses: dayWaits.filter((m) => m >= SLA_MINUTES).length,
        unanswered: waits.filter((w) => w.minutes === null && dayOf(w.askedAt) === day).length,
        appointmentsBooked: bookings.filter((b) => dayOf(b.createdAt) === day).length,
      };
    });

    // When patients write in (clinic time), to plan who is on shift.
    const hourly = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      patientMessages: patientMsgs.filter((m) => hourOf(m.createdAt) === h).length,
      staffReplies: staffMsgs.filter((m) => hourOf(m.createdAt) === h).length,
    }));

    const all = answered.map((w) => w.minutes);
    res.status(200).json({
      success: true,
      data: {
        ...meta(req, period),
        team: {
          chats: new Set([...patientMsgs, ...staffMsgs].map((m) => m.conversationId)).size,
          patientMessages: patientMsgs.length,
          staffReplies: staffMsgs.length,
          firstResponses: all.length,
          avgResponseMinutes: avg(all),
          medianResponseMinutes: percentile(all, 50),
          p90ResponseMinutes: percentile(all, 90),
          withinSlaPercent: all.length ? Math.round((all.filter((m) => m < SLA_MINUTES).length / all.length) * 100) : null,
          lateResponses: all.filter((m) => m >= SLA_MINUTES).length,
          unanswered: waits.length - answered.length,
          responseBands: bands(all),
          appointmentsBooked: bookings.length,
        },
        agents,
        daily,
        hourly,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/reports/campaigns ─────────────────────────────────
// Campaigns that started in the period, from sent to booked: delivery, reads,
// replies, booking requests, patients booked, couldn't-book reasons, opt-outs.
const getCampaignsReport = async (req, res, next) => {
  try {
    const period = readPeriod(req);
    const line = period.numberId ? { whatsappNumberId: period.numberId } : {};
    const campaigns = await prisma.campaign.findMany({
      where: { startedAt: { gte: period.from, lt: period.to }, ...line },
      orderBy: { startedAt: "asc" },
      include: {
        template: { select: { name: true } },
        whatsappNumber: { select: { label: true } },
        createdBy: PERSON,
        reviewedBy: PERSON,
      },
    });
    const ids = campaigns.map((c) => c.id);
    if (ids.length === 0) {
      return res.status(200).json({ success: true, data: { ...meta(req, period), totals: null, campaigns: [] } });
    }
    const [recipients, requests, bookings] = await Promise.all([
      prisma.campaignRecipient.findMany({
        where: { campaignId: { in: ids } },
        select: { campaignId: true, customerId: true, status: true, sentAt: true, repliedAt: true, message: { select: { status: true } } },
      }),
      prisma.bookingRequest.findMany({ where: { OR: [{ campaignId: { in: ids } }, { suggestedCampaignId: { in: ids } }] }, select: { campaignId: true, suggestedCampaignId: true, status: true, notBookedReason: true, customerId: true } }),
      prisma.booking.findMany({ where: { campaignId: { in: ids }, status: "BOOKED" }, select: { campaignId: true, customerId: true, service: true } }),
    ]);
    // Opt-outs on the campaign's line by its recipients within 7 days of sending.
    const optOuts = await prisma.customerOptOut.findMany({
      where: { customerId: { in: [...new Set(recipients.map((r) => r.customerId))] } },
      select: { customerId: true, whatsappNumberId: true, optedOutAt: true },
    });

    const rows = campaigns.map((c) => {
      const rs = recipients.filter((r) => r.campaignId === c.id);
      const sent = rs.filter((r) => r.status === "SENT");
      const delivered = sent.filter((r) => ["DELIVERED", "READ"].includes(r.message?.status)).length;
      const read = sent.filter((r) => r.message?.status === "READ").length;
      const replied = rs.filter((r) => r.repliedAt).length;
      const reqs = requests.filter((r) => r.campaignId === c.id);
      const suggested = requests.filter((r) => r.suggestedCampaignId === c.id && r.campaignId !== c.id).length;
      const bk = bookings.filter((b) => b.campaignId === c.id);
      const patientsBooked = new Set(bk.map((b) => b.customerId)).size;
      const sentIds = new Map(sent.map((r) => [r.customerId, r.sentAt]));
      const optedOut = optOuts.filter((o) => o.whatsappNumberId === c.whatsappNumberId && sentIds.has(o.customerId) && sentIds.get(o.customerId) && o.optedOutAt >= sentIds.get(o.customerId) && o.optedOutAt - sentIds.get(o.customerId) <= 7 * 24 * 60 * 60 * 1000).length;
      const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
      return {
        id: c.id,
        name: c.name,
        line: c.whatsappNumber?.label || null,
        template: c.template?.name || null,
        category: c.category,
        status: c.status,
        createdBy: who(c.createdBy),
        approvedBy: who(c.reviewedBy),
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        recipients: rs.length,
        sent: sent.length,
        failed: rs.filter((r) => r.status === "FAILED").length,
        skipped: rs.filter((r) => r.status === "SKIPPED").length,
        delivered,
        read,
        replied,
        bookingRequests: reqs.length,
        suggestedRequests: suggested,
        requestsBooked: reqs.filter((r) => r.status === "BOOKED").length,
        requestsNotBooked: reqs.filter((r) => r.status === "NOT_BOOKED").length,
        requestsOpen: reqs.filter((r) => r.status === "NEW" || r.status === "IN_PROGRESS").length,
        notBookedReasons: countBy(reqs.filter((r) => r.status === "NOT_BOOKED"), (r) => r.notBookedReason || "OTHER"),
        patientsBooked,
        appointmentsBooked: bk.length,
        services: countBy(bk, (b) => b.service || "—"),
        optOuts: optedOut,
        rates: {
          delivered: pct(delivered, sent.length),
          read: pct(read, sent.length),
          replied: pct(replied, sent.length),
          booked: pct(patientsBooked, sent.length),
          bookedOfReplied: pct(patientsBooked, replied),
          optOut: pct(optedOut, sent.length),
        },
      };
    });
    const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
    res.status(200).json({
      success: true,
      data: {
        ...meta(req, period),
        totals: {
          campaigns: rows.length,
          sent: sum("sent"),
          delivered: sum("delivered"),
          read: sum("read"),
          replied: sum("replied"),
          bookingRequests: sum("bookingRequests"),
          patientsBooked: sum("patientsBooked"),
          appointmentsBooked: sum("appointmentsBooked"),
          optOuts: sum("optOuts"),
        },
        campaigns: rows,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/supervision/reports/chats ─────────────────────────────────────
// One row per chat with a message in the period, with everything a supervisor
// filters on: who handled it, how fast, longest wait, outcome, booking, source.
const getChatsReport = async (req, res, next) => {
  try {
    const period = readPeriod(req);
    const inPeriod = { gte: period.from, lt: period.to };
    const line = period.numberId ? { whatsappNumberId: period.numberId } : {};
    const msgs = await prisma.message.findMany({
      where: { createdAt: inPeriod, deletedAt: null, ...(period.numberId ? { conversation: { whatsappNumberId: period.numberId } } : {}) },
      select: { conversationId: true, senderType: true, senderId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const ids = [...new Set(msgs.map((m) => m.conversationId))].slice(0, 5000);
    const [convs, waits, users, lines] = await Promise.all([
      prisma.conversation.findMany({
        where: { id: { in: ids } },
        select: {
          id: true, status: true, outcome: true, outcomeAt: true, followUpAt: true, lastMessageAt: true, createdAt: true, whatsappNumberId: true,
          customer: { select: { id: true, name: true, phone: true, tags: true, optedOut: true } },
          assignedAgent: PERSON,
          outcomeBy: PERSON,
          bookingRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, notBookedReason: true, leadSource: true, sourceStatus: true, campaign: { select: { name: true } } } },
          // Appointments still booked (cancelled ones don't count, as in every other report).
          _count: { select: { notes: true, bookings: { where: { status: "BOOKED" } } } },
        },
      }),
      responseTimes(period.from, line, period.to),
      prisma.user.findMany({ select: { id: true, name: true, username: true } }),
      prisma.whatsAppNumber.findMany({ select: { id: true, label: true } }),
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name || u.username]));
    const lineName = new Map(lines.map((l) => [l.id, l.label]));
    const byConv = new Map();
    for (const m of msgs) {
      const e = byConv.get(m.conversationId) || byConv.set(m.conversationId, { patient: 0, staff: 0, bot: 0, campaign: 0, first: m.createdAt, last: m.createdAt, staffIds: new Set() }).get(m.conversationId);
      if (m.senderType === "CUSTOMER") e.patient++;
      else if (m.senderType === "BOT") e.bot++;
      else if (m.senderId) { e.staff++; e.staffIds.add(m.senderId); }
      else e.campaign++;
      e.last = m.createdAt;
    }
    const rows = convs
      .map((c) => {
        const e = byConv.get(c.id);
        const w = waits.filter((x) => x.conversationId === c.id);
        const done = w.filter((x) => x.minutes !== null).map((x) => x.minutes);
        const stillWaiting = w.filter((x) => x.minutes === null).map((x) => workingMinutesBetween(x.askedAt, period.to < new Date() ? period.to : new Date()));
        const req0 = c.bookingRequests[0];
        return {
          id: c.id,
          patient: c.customer.name,
          phone: c.customer.phone,
          tags: c.customer.tags,
          optedOut: c.customer.optedOut,
          line: lineName.get(c.whatsappNumberId) || null,
          assignedTo: who(c.assignedAgent),
          repliedBy: [...e.staffIds].map((id) => userName.get(id)).filter(Boolean),
          status: c.status,
          outcome: c.outcome,
          outcomeBy: who(c.outcomeBy),
          followUpAt: c.followUpAt,
          firstMessageAt: e.first,
          lastMessageAt: e.last,
          patientMessages: e.patient,
          staffMessages: e.staff,
          botMessages: e.bot,
          campaignMessages: e.campaign,
          firstResponses: done.length,
          avgResponseMinutes: avg(done),
          longestWaitMinutes: Math.max(0, ...done, ...stillWaiting),
          lateResponses: done.filter((m) => m >= SLA_MINUTES).length,
          unanswered: stillWaiting.length > 0,
          bookingRequest: req0 ? req0.status : null,
          notBookedReason: req0 ? req0.notBookedReason : null,
          leadSource: req0 ? req0.leadSource : null,
          campaign: req0?.campaign?.name || null,
          appointments: c._count.bookings,
          notes: c._count.notes,
        };
      })
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    res.status(200).json({
      success: true,
      data: {
        ...meta(req, period),
        summary: {
          chats: rows.length,
          unanswered: rows.filter((r) => r.unanswered).length,
          withLateResponses: rows.filter((r) => r.lateResponses > 0).length,
          byOutcome: countBy(rows, (r) => r.outcome || "NONE"),
          byStatus: countBy(rows, (r) => r.status),
          byLine: countBy(rows, (r) => r.line || "—"),
        },
        chats: rows,
        truncated: byConv.size > ids.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { getBookingsReport, getTeamReport, getCampaignsReport, getChatsReport };
