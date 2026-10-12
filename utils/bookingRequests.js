// Booking requests: "this patient wants to book".
//
// The booking flow creates one when it has collected what the patient wants;
// an agent can create one for a patient who simply asked in chat. An agent
// then books it in Dok32 and records the appointment(s) here — one request can
// become several appointments (laser + cleaning, two family members…). Or the
// agent closes it as "couldn't book" with a reason, so nothing stays open.
//
// Every appointment is a Booking linked to its request and to the campaign the
// request came from, which is how a campaign's bookings are counted.

const prisma = require("../config/prisma");
const AppError = require("./AppError");
const { emitToNumber } = require("./socket");
const logAudit = require("./audit");

const OPEN = ["NEW", "IN_PROGRESS"];
const NOT_BOOKED_REASONS = ["NO_ANSWER", "NOT_INTERESTED", "PRICE", "CALL_BACK_LATER", "BOOKED_ELSEWHERE", "OTHER"];
const MAX_APPOINTMENTS = 10;
const ATTRIBUTION_DAYS = 7;

// Answers a booking flow collects. A run that saved any of these asked for a
// booking. Named keys first; any key about a date / appointment / booking too,
// since flow authors name their own fields.
const BOOKING_KEYS = ["preferred_date", "preferred_time", "contact_number", "service", "appointment_date"];
const BOOKING_KEY_RE = /date|appointment|booking|book_/i;
const answersOf = (data) => (data && typeof data === "object" && data.answers && typeof data.answers === "object" ? data.answers : {});
const isBookingAnswers = (answers) =>
  Object.entries(answers || {}).some(([k, v]) => v !== null && v !== undefined && v !== "" && (BOOKING_KEYS.includes(k) || BOOKING_KEY_RE.test(k)));

const emitChange = (request, event = "booking_request.updated") =>
  emitToNumber(request.whatsappNumberId, event, { requestId: request.id, conversationId: request.conversationId, status: request.status });

// The campaign a patient is answering: the one whose reply they're in, else
// the latest campaign that reached them on this line in the last week.
async function campaignFor(conversation) {
  const recipient = await prisma.campaignRecipient.findFirst({
    where: {
      customerId: conversation.customerId,
      status: "SENT",
      sentAt: { gte: new Date(Date.now() - ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000) },
      campaign: { whatsappNumberId: conversation.whatsappNumberId },
    },
    orderBy: { sentAt: "desc" },
    select: { campaignId: true },
  });
  return recipient ? recipient.campaignId : null;
}

// Called when a flow run finishes (completed or handed to the team). Creates
// the request once per run; a run without booking answers creates nothing.
async function createFromFlowRun(runId) {
  const run = await prisma.flowRun.findUnique({
    where: { id: runId },
    include: { conversation: { select: { id: true, customerId: true, whatsappNumberId: true } } },
  });
  if (!run || !isBookingAnswers(answersOf(run.data))) return null;
  const existing = await prisma.bookingRequest.findUnique({ where: { flowRunId: run.id } });
  if (existing) return existing;
  try {
    const request = await prisma.bookingRequest.create({
      data: {
        conversationId: run.conversationId,
        customerId: run.customerId,
        whatsappNumberId: run.conversation.whatsappNumberId,
        source: "FLOW",
        flowRunId: run.id,
        campaignId: run.campaignId ?? (await campaignFor(run.conversation)),
        requested: answersOf(run.data),
      },
    });
    emitChange(request, "booking_request.created");
    return request;
  } catch (err) {
    if (err.code === "P2002") return prisma.bookingRequest.findUnique({ where: { flowRunId: run.id } });
    throw err;
  }
}

// An agent's own request for a patient who asked in chat.
async function createForConversation(conversation, { service, preferredDate, note } = {}, user) {
  const requested = {};
  if (service) requested.service = String(service).trim().slice(0, 120);
  if (preferredDate) requested.preferred_date = String(preferredDate).trim().slice(0, 120);
  const request = await prisma.bookingRequest.create({
    data: {
      conversationId: conversation.id,
      customerId: conversation.customerId,
      whatsappNumberId: conversation.whatsappNumberId,
      source: "AGENT",
      campaignId: await campaignFor(conversation),
      requested,
      note: note ? String(note).trim().slice(0, 1000) : null,
      createdById: user.id,
      // Whoever creates it is working on it.
      status: "IN_PROGRESS",
      claimedById: user.id,
      claimedAt: new Date(),
    },
  });
  logAudit({ action: "booking_request.created", actor: user, targetType: "conversation", targetId: conversation.id, details: { requestId: request.id } });
  emitChange(request, "booking_request.created");
  return request;
}

// Checks and cleans the appointments an agent entered.
function cleanAppointments(list) {
  if (!Array.isArray(list) || list.length === 0) throw new AppError("Add at least one appointment", 400);
  if (list.length > MAX_APPOINTMENTS) throw new AppError(`At most ${MAX_APPOINTMENTS} appointments at once`, 400);
  const now = Date.now();
  return list.map((a, i) => {
    const n = list.length > 1 ? ` (appointment ${i + 1})` : "";
    const service = String(a?.service || "").trim();
    if (!service) throw new AppError(`Enter the service${n}`, 400);
    const at = new Date(a?.appointmentAt);
    if (!a?.appointmentAt || Number.isNaN(at.getTime())) throw new AppError(`Enter the appointment date and time${n}`, 400);
    if (at.getTime() < now - 24 * 60 * 60 * 1000) throw new AppError(`The appointment is in the past${n}`, 400);
    const opt = (v, max) => (v ? String(v).trim().slice(0, max) || null : null);
    return { service: service.slice(0, 120), appointmentAt: at, doctor: opt(a.doctor, 120), dok32Ref: opt(a.dok32Ref, 60), note: opt(a.note, 1000) };
  });
}

// Records appointment(s) booked from a request. A request already BOOKED can
// take more (the patient added something later). The chat's outcome becomes
// BOOKED.
async function bookRequest(requestId, appointments, user, scope = {}) {
  const clean = cleanAppointments(appointments);
  const request = await prisma.bookingRequest.findFirst({ where: { id: requestId, ...scope } });
  if (!request) throw new AppError("Booking request not found", 404);
  if (request.status === "NOT_BOOKED") throw new AppError("This request was closed as not booked — reopen it first", 409, "REQUEST_CLOSED");
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    for (const a of clean) {
      await tx.booking.create({
        data: {
          ...a,
          conversationId: request.conversationId,
          customerId: request.customerId,
          whatsappNumberId: request.whatsappNumberId,
          requestId: request.id,
          campaignId: request.campaignId,
          createdById: user.id,
        },
      });
    }
    const updated = await tx.bookingRequest.update({
      where: { id: request.id },
      data: {
        status: "BOOKED",
        handledById: user.id,
        handledAt: now,
        claimedById: request.claimedById ?? user.id,
        claimedAt: request.claimedAt ?? now,
        notBookedReason: null,
        notBookedNote: null,
      },
    });
    await tx.conversation.update({
      where: { id: request.conversationId },
      data: { outcome: "BOOKED", outcomeAt: now, outcomeById: user.id, followUpAt: null },
    });
    return updated;
  });
  logAudit({
    action: "booking_request.booked",
    actor: user,
    targetType: "conversation",
    targetId: request.conversationId,
    details: { requestId: request.id, appointments: clean.map((a) => ({ service: a.service, appointmentAt: a.appointmentAt })) },
  });
  emitChange(result);
  emitToNumber(request.whatsappNumberId, "conversation.outcome", { conversationId: request.conversationId, outcome: "BOOKED" });
  return result;
}

async function closeNotBooked(requestId, { reason, note }, user, scope = {}) {
  if (!NOT_BOOKED_REASONS.includes(reason)) throw new AppError(`Pick a reason: ${NOT_BOOKED_REASONS.join(", ")}`, 400);
  if (reason === "OTHER" && !String(note || "").trim()) throw new AppError("Say what happened", 400);
  const request = await prisma.bookingRequest.findFirst({ where: { id: requestId, ...scope } });
  if (!request) throw new AppError("Booking request not found", 404);
  const live = await prisma.booking.count({ where: { requestId: request.id, status: "BOOKED" } });
  if (live > 0) throw new AppError("This request already has a booked appointment — cancel it first", 409, "REQUEST_HAS_BOOKINGS");
  const updated = await prisma.bookingRequest.update({
    where: { id: request.id },
    data: { status: "NOT_BOOKED", notBookedReason: reason, notBookedNote: note ? String(note).trim().slice(0, 1000) : null, handledById: user.id, handledAt: new Date() },
  });
  logAudit({ action: "booking_request.not_booked", actor: user, targetType: "conversation", targetId: request.conversationId, details: { requestId: request.id, reason } });
  emitChange(updated);
  return updated;
}

// Taking a request: NEW → IN_PROGRESS for this agent. Taking one a colleague
// already has needs `force` (the UI asks first).
async function claimRequest(requestId, user, { force = false } = {}, scope = {}) {
  const request = await prisma.bookingRequest.findFirst({ where: { id: requestId, ...scope }, include: { claimedBy: { select: { id: true, name: true, username: true } } } });
  if (!request) throw new AppError("Booking request not found", 404);
  if (!OPEN.includes(request.status)) return request;
  if (request.claimedById && request.claimedById !== user.id && !force) {
    throw new AppError(
      `${request.claimedBy?.name || request.claimedBy?.username || "A colleague"} is already handling this request`,
      409,
      "REQUEST_CLAIMED",
      { claimedBy: request.claimedBy },
    );
  }
  const { count } = await prisma.bookingRequest.updateMany({
    where: { id: request.id, status: { in: OPEN }, ...(force ? {} : { OR: [{ claimedById: null }, { claimedById: user.id }] }) },
    data: { status: "IN_PROGRESS", claimedById: user.id, claimedAt: new Date() },
  });
  if (count === 0) throw new AppError("Someone else just took this request", 409, "REQUEST_CLAIMED");
  const updated = await prisma.bookingRequest.findUnique({ where: { id: request.id } });
  emitChange(updated);
  return updated;
}

async function reopenRequest(requestId, user, scope = {}) {
  const request = await prisma.bookingRequest.findFirst({ where: { id: requestId, ...scope } });
  if (!request) throw new AppError("Booking request not found", 404);
  if (request.status !== "NOT_BOOKED") throw new AppError("Only a request closed as not booked can be reopened", 400);
  const updated = await prisma.bookingRequest.update({
    where: { id: request.id },
    data: { status: "IN_PROGRESS", claimedById: user.id, claimedAt: new Date(), notBookedReason: null, notBookedNote: null, handledById: null, handledAt: null },
  });
  emitChange(updated);
  return updated;
}

module.exports = {
  OPEN,
  NOT_BOOKED_REASONS,
  isBookingAnswers,
  answersOf,
  campaignFor,
  createFromFlowRun,
  createForConversation,
  cleanAppointments,
  bookRequest,
  closeNotBooked,
  claimRequest,
  reopenRequest,
};
