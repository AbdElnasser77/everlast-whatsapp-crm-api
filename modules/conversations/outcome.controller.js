const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { emitToNumber } = require("../../utils/socket");
const { roleHasPermission } = require("../../config/permissions");
const br = require("../../utils/bookingRequests");

// How a chat ended up, set by the agent handling it, plus the appointment when
// it was BOOKED and staff-only notes. What the Supervision page reports on.

const OUTCOMES = ["BOOKED", "NOT_INTERESTED", "FOLLOW_UP", "NO_ANSWER"];
const PERSON = { select: { id: true, name: true, username: true } };

const validDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function loadConversation(req) {
  const id = parseInt(req.params.id);
  const conversation = await prisma.conversation.findFirst({ where: { id, whatsappNumberId: req.numberId } });
  if (!conversation) throw new AppError("Conversation not found", 404);
  return conversation;
}

const outcomeView = (c) => ({
  id: c.id,
  outcome: c.outcome,
  outcomeAt: c.outcomeAt,
  outcomeBy: c.outcomeBy || null,
  followUpAt: c.followUpAt,
  bookings: c.bookings || [],
});

// ─── PUT /api/conversations/:id/outcome ─────────────────────────────────────
// { outcome: "BOOKED", booking: { appointmentAt, service?, note? } }
// { outcome: "FOLLOW_UP", followUpAt }   { outcome: "NOT_INTERESTED" | "NO_ANSWER" }
// { outcome: null } clears it.
const setOutcome = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const outcome = req.body.outcome ?? null;
    if (outcome !== null && !OUTCOMES.includes(outcome)) {
      return next(new AppError(`Outcome must be one of ${OUTCOMES.join(", ")}`, 400));
    }

    const now = new Date();
    // followUpNotifiedAt reset: a new follow-up date gets its own reminder.
    const data = { outcome, outcomeAt: outcome ? now : null, outcomeById: outcome ? req.user.id : null, followUpAt: null, followUpNotifiedAt: null };

    // "Not interested", "No answer" or clearing the outcome would contradict
    // appointments that are still booked — those are cancelled first, on purpose.
    if (outcome === "NOT_INTERESTED" || outcome === "NO_ANSWER" || outcome === null) {
      const live = await prisma.booking.count({ where: { conversationId: conversation.id, status: "BOOKED" } });
      if (live > 0) {
        return next(new AppError(
          `This chat has ${live} booked appointment${live === 1 ? "" : "s"}. Cancel ${live === 1 ? "it" : "them"} first (contact panel → Bookings) if the patient no longer wants to come.`,
          409,
          "HAS_APPOINTMENTS",
        ));
      }
    }

    // Booked is recorded through the chat's booking request (the open one, or a
    // new one) so every appointment has a request, a campaign and a history.
    // Accepts several appointments, or the older single `booking`.
    if (outcome === "BOOKED") {
      const list = Array.isArray(req.body.appointments)
        ? req.body.appointments
        : req.body.booking
          ? [req.body.booking]
          : [];
      br.cleanAppointments(list); // validate before creating anything
      let request = await prisma.bookingRequest.findFirst({
        where: { conversationId: conversation.id, status: { in: br.OPEN } },
        orderBy: { createdAt: "desc" },
      });
      if (!request) request = await br.createForConversation(conversation, {}, req.user);
      await br.bookRequest(request.id, list, req.user, { conversationId: conversation.id }, req.body.source || null);
      const after = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        include: { outcomeBy: PERSON, bookings: { orderBy: { createdAt: "desc" }, include: { createdBy: PERSON } } },
      });
      return res.status(200).json({ success: true, data: outcomeView(after) });
    }
    if (outcome === "FOLLOW_UP") {
      const followUpAt = validDate(req.body.followUpAt);
      if (!followUpAt) return next(new AppError("Choose when to follow up", 400));
      data.followUpAt = followUpAt;
    }

    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data,
      include: { outcomeBy: PERSON, bookings: { orderBy: { createdAt: "desc" }, include: { createdBy: PERSON } } },
    });

    // The open booking request follows the chat: "Not interested" / "No
    // answer" close it with that reason, so the Bookings queue and the reports
    // tell the same story as the chat.
    if (outcome === "NOT_INTERESTED" || outcome === "NO_ANSWER") {
      const open = await prisma.bookingRequest.findMany({ where: { conversationId: conversation.id, status: { in: br.OPEN } }, select: { id: true } });
      for (const r of open) {
        await br.closeNotBooked(r.id, { reason: outcome, note: "Closed from the chat outcome" }, req.user, {}, { syncOutcome: false });
      }
    }

    logAudit({
      action: "conversation.outcome_set",
      actor: req.user,
      targetType: "conversation",
      targetId: conversation.id,
      details: {
        outcome,
        previousOutcome: conversation.outcome,
        followUpAt: data.followUpAt,
      },
    });
    emitToNumber(conversation.whatsappNumberId, "conversation.outcome", { conversationId: conversation.id, outcome });
    emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId: conversation.id });
    res.status(200).json({ success: true, data: outcomeView(updated) });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/conversations/:id/bookings/:bookingId/cancel ─────────────────
// The appointment was cancelled. Kept in the history as CANCELLED; if it was
// the chat's only live booking, the chat's outcome goes back to none.
const cancelBooking = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const bookingId = parseInt(req.params.bookingId);
    const { count } = await prisma.booking.updateMany({
      where: { id: bookingId, conversationId: conversation.id, status: "BOOKED" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    });
    if (count === 0) return next(new AppError("Booking not found or already cancelled", 404));
    const cancelled = await prisma.booking.findUnique({ where: { id: bookingId }, select: { requestId: true } });
    if (cancelled?.requestId) {
      const stillBooked = await prisma.booking.count({ where: { requestId: cancelled.requestId, status: "BOOKED" } });
      if (stillBooked === 0) {
        // Nothing booked any more: back on the agent's list to rebook or close.
        await prisma.bookingRequest.updateMany({
          where: { id: cancelled.requestId, status: "BOOKED" },
          data: { status: "IN_PROGRESS", handledById: null, handledAt: null },
        });
      }
    }
    const live = await prisma.booking.count({ where: { conversationId: conversation.id, status: "BOOKED" } });
    if (live === 0 && conversation.outcome === "BOOKED") {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { outcome: null, outcomeAt: null, outcomeById: null } });
    }
    logAudit({
      action: "conversation.booking_cancelled",
      actor: req.user,
      targetType: "conversation",
      targetId: conversation.id,
      details: { bookingId },
    });
    const updated = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: { outcomeBy: PERSON, bookings: { orderBy: { createdAt: "desc" }, include: { createdBy: PERSON } } },
    });
    emitToNumber(conversation.whatsappNumberId, "conversation.outcome", { conversationId: conversation.id, outcome: updated.outcome });
    res.status(200).json({ success: true, data: outcomeView(updated) });
  } catch (err) {
    next(err);
  }
};

// ─── Notes: GET / POST /api/conversations/:id/notes, DELETE …/notes/:noteId ──
const listNotes = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const notes = await prisma.conversationNote.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      include: { author: PERSON },
    });
    res.status(200).json({ success: true, data: notes });
  } catch (err) {
    next(err);
  }
};

const addNote = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const body = String(req.body.body || "").trim();
    if (!body) return next(new AppError("The note is empty", 400));
    if (body.length > 2000) return next(new AppError("Notes are limited to 2000 characters", 400));
    const note = await prisma.conversationNote.create({
      data: { conversationId: conversation.id, authorId: req.user.id, body },
      include: { author: PERSON },
    });
    emitToNumber(conversation.whatsappNumberId, "conversation.note", { conversationId: conversation.id, noteId: note.id });
    res.status(201).json({ success: true, data: note });
  } catch (err) {
    next(err);
  }
};

// Your own notes; a supervisor can remove anyone's.
const deleteNote = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const note = await prisma.conversationNote.findFirst({ where: { id: parseInt(req.params.noteId), conversationId: conversation.id } });
    if (!note) return next(new AppError("Note not found", 404));
    if (note.authorId !== req.user.id && !roleHasPermission(req.user.role, "team:supervise")) {
      return next(new AppError("You can only delete your own notes", 403));
    }
    await prisma.conversationNote.delete({ where: { id: note.id } });
    emitToNumber(conversation.whatsappNumberId, "conversation.note", { conversationId: conversation.id, noteId: note.id });
    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
};

module.exports = { setOutcome, cancelBooking, listNotes, addNote, deleteNote, OUTCOMES };
