const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const br = require("../../utils/bookingRequests");
const { workingMinutesBetween } = require("../../utils/workingTime");
const { startOfLocalDay } = require("../supervision/supervision.controller");

// The agents' booking queue, for the line in view (like the inbox). See
// utils/bookingRequests.js for the rules.

const PERSON = { select: { id: true, name: true, username: true } };
const STATUSES = ["NEW", "IN_PROGRESS", "BOOKED", "NOT_BOOKED"];

const INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  campaign: { select: { id: true, name: true } },
  suggestedCampaign: { select: { id: true, name: true } },
  claimedBy: PERSON,
  handledBy: PERSON,
  bookings: { orderBy: { appointmentAt: "asc" }, include: { createdBy: PERSON } },
  conversation: {
    select: {
      id: true, status: true, lastMessage: true, lastMessageAt: true, lastSenderType: true,
      awaitingReplySince: true, assignedAgent: PERSON,
    },
  },
};

const view = (r, now = new Date()) => ({
  ...r,
  // How long it has been open (working time) — for "waiting too long".
  openMinutes: br.OPEN.includes(r.status) ? workingMinutesBetween(r.createdAt, now) : null,
});

const scopeOf = (req) => ({ whatsappNumberId: req.numberId });

// ─── GET /api/booking-requests ──────────────────────────────────────────────
// ?status=open (default) | NEW | IN_PROGRESS | BOOKED | NOT_BOOKED | all
// &mine=1  &search=  &page=  &limit=
const listRequests = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const status = String(req.query.status || "open");
    const where = { ...scopeOf(req) };
    if (status === "open") where.status = { in: br.OPEN };
    else if (STATUSES.includes(status)) where.status = status;
    if (req.query.mine === "1") where.claimedById = req.user.id;
    const search = String(req.query.search || "").trim();
    if (search) {
      where.customer = { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search.replace(/^\+/, "") } }] };
    }
    // Open ones oldest first (first come, first served); closed ones newest first.
    const orderBy = status === "open" || status === "NEW" || status === "IN_PROGRESS" ? { createdAt: "asc" } : { updatedAt: "desc" };
    const [rows, total] = await Promise.all([
      prisma.bookingRequest.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, include: INCLUDE }),
      prisma.bookingRequest.count({ where }),
    ]);
    const now = new Date();
    res.status(200).json({
      success: true,
      data: rows.map((r) => view(r, now)),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/booking-requests/counts ───────────────────────────────────────
// For the sidebar badge and the queue tabs.
const getCounts = async (req, res, next) => {
  try {
    const scope = scopeOf(req);
    const startOfToday = startOfLocalDay();
    const [fresh, inProgress, mine, bookedToday] = await Promise.all([
      prisma.bookingRequest.count({ where: { ...scope, status: "NEW" } }),
      prisma.bookingRequest.count({ where: { ...scope, status: "IN_PROGRESS" } }),
      prisma.bookingRequest.count({ where: { ...scope, status: { in: br.OPEN }, claimedById: req.user.id } }),
      prisma.booking.count({ where: { whatsappNumberId: req.numberId, status: "BOOKED", createdAt: { gte: startOfToday } } }),
    ]);
    res.status(200).json({ success: true, data: { new: fresh, inProgress, open: fresh + inProgress, mine, bookedToday } });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/booking-requests/:id ──────────────────────────────────────────
const getRequest = async (req, res, next) => {
  try {
    const r = await prisma.bookingRequest.findFirst({ where: { id: parseInt(req.params.id), ...scopeOf(req) }, include: INCLUDE });
    if (!r) return next(new AppError("Booking request not found", 404));
    res.status(200).json({ success: true, data: view(r) });
  } catch (err) {
    next(err);
  }
};

const reply = async (res, id, code = 200) => {
  const r = await prisma.bookingRequest.findUnique({ where: { id }, include: INCLUDE });
  res.status(code).json({ success: true, data: view(r) });
};

// ─── POST /api/booking-requests/:id/claim { force? } ────────────────────────
const claim = async (req, res, next) => {
  try {
    const r = await br.claimRequest(parseInt(req.params.id), req.user, { force: req.body?.force === true }, scopeOf(req));
    await reply(res, r.id);
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/booking-requests/:id/book { appointments: [...] } ────────────
// Each: { service, appointmentAt, doctor?, dok32Ref?, note? }
const book = async (req, res, next) => {
  try {
    const r = await br.bookRequest(parseInt(req.params.id), req.body?.appointments, req.user, scopeOf(req), req.body?.source || null);
    await reply(res, r.id);
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/booking-requests/:id/source { leadSource, campaignId?, note? } ─
const setSource = async (req, res, next) => {
  try {
    const r = await br.setSource(parseInt(req.params.id), req.body || {}, req.user, scopeOf(req));
    await reply(res, r.id);
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/booking-requests/source-options ───────────────────────────────
// The choices for "where did this patient come from": the fixed channels,
// and this line's campaigns from the last 90 days.
const getSourceOptions = async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { whatsappNumberId: req.numberId, deletedAt: null, startedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
      orderBy: { startedAt: "desc" },
      select: { id: true, name: true, startedAt: true },
    });
    res.status(200).json({ success: true, data: { leadSources: br.LEAD_SOURCES, campaigns } });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/booking-requests/:id/not-booked { reason, note? } ────────────
const notBooked = async (req, res, next) => {
  try {
    const r = await br.closeNotBooked(parseInt(req.params.id), { reason: req.body?.reason, note: req.body?.note, followUpAt: req.body?.followUpAt }, req.user, scopeOf(req));
    await reply(res, r.id);
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/booking-requests/:id/reopen ──────────────────────────────────
const reopen = async (req, res, next) => {
  try {
    const r = await br.reopenRequest(parseInt(req.params.id), req.user, scopeOf(req));
    await reply(res, r.id);
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/conversations/:id/booking-requests { service?, preferredDate?, note? }
// A patient asked to book in chat: the agent opens a request for them.
const createForChat = async (req, res, next) => {
  try {
    const conversation = await prisma.conversation.findFirst({ where: { id: parseInt(req.params.id), whatsappNumberId: req.numberId } });
    if (!conversation) return next(new AppError("Conversation not found", 404));
    const r = await br.createForConversation(conversation, req.body || {}, req.user);
    await reply(res, r.id, 201);
  } catch (err) {
    next(err);
  }
};

module.exports = { listRequests, getCounts, getRequest, claim, book, notBooked, reopen, createForChat, setSource, getSourceOptions, NOT_BOOKED_REASONS: br.NOT_BOOKED_REASONS };
