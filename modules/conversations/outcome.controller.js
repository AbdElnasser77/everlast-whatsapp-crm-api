const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { emitToNumber } = require("../../utils/socket");
const { roleHasPermission } = require("../../config/permissions");

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
    const data = { outcome, outcomeAt: outcome ? now : null, outcomeById: outcome ? req.user.id : null, followUpAt: null };
    let booking = null;

    if (outcome === "BOOKED") {
      const b = req.body.booking || {};
      const appointmentAt = validDate(b.appointmentAt);
      if (!appointmentAt) return next(new AppError("Enter the appointment date and time", 400));
      if (appointmentAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
        return next(new AppError("The appointment is in the past", 400));
      }
      const service = b.service ? String(b.service).trim().slice(0, 120) : null;
      const note = b.note ? String(b.note).trim().slice(0, 1000) : null;
      booking = { appointmentAt, service: service || null, note: note || null };
    }
    if (outcome === "FOLLOW_UP") {
      const followUpAt = validDate(req.body.followUpAt);
      if (!followUpAt) return next(new AppError("Choose when to follow up", 400));
      data.followUpAt = followUpAt;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (booking) {
        await tx.booking.create({
          data: {
            ...booking,
            conversationId: conversation.id,
            customerId: conversation.customerId,
            whatsappNumberId: conversation.whatsappNumberId,
            createdById: req.user.id,
          },
        });
      }
      return tx.conversation.update({
        where: { id: conversation.id },
        data,
        include: { outcomeBy: PERSON, bookings: { orderBy: { createdAt: "desc" }, include: { createdBy: PERSON } } },
      });
    });

    logAudit({
      action: "conversation.outcome_set",
      actor: req.user,
      targetType: "conversation",
      targetId: conversation.id,
      details: {
        outcome,
        previousOutcome: conversation.outcome,
        followUpAt: data.followUpAt,
        ...(booking ? { appointmentAt: booking.appointmentAt, service: booking.service } : {}),
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
