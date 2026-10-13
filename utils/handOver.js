// Handing someone's work to a colleague (or back to the shared queue): their
// open chats and the booking requests they had taken. Used at the end of a
// shift, by a supervisor covering an absence, and when an account is
// deactivated or loses inbox access — so no patient is left with an owner who
// isn't there.

const prisma = require("../config/prisma");
const AppError = require("./AppError");
const logAudit = require("./audit");
const { emitToNumber } = require("./socket");
const { isAssignable } = require("./conversationAssignment");

async function handOver(fromUserId, toUserId, actor, { reason = "hand over" } = {}) {
  let to = null;
  if (toUserId !== null && toUserId !== undefined && toUserId !== "") {
    to = await prisma.user.findUnique({ where: { id: parseInt(toUserId) }, select: { id: true, username: true, name: true, role: true, isActive: true } });
    if (!to || !isAssignable(to)) throw new AppError("That person can't take chats (inactive, or no inbox access)", 400, "NOT_ASSIGNABLE");
    if (to.id === fromUserId) throw new AppError("Choose someone else to hand over to", 400);
  }

  const chats = await prisma.conversation.findMany({
    where: { assignedAgentId: fromUserId, status: { not: "RESOLVED" } },
    select: { id: true, whatsappNumberId: true },
  });
  const requests = await prisma.bookingRequest.findMany({
    where: { claimedById: fromUserId, status: { in: ["NEW", "IN_PROGRESS"] } },
    select: { id: true, whatsappNumberId: true, conversationId: true },
  });

  await prisma.$transaction([
    prisma.conversation.updateMany({
      where: { id: { in: chats.map((c) => c.id) }, assignedAgentId: fromUserId },
      data: { assignedAgentId: to ? to.id : null },
    }),
    // Taken requests go to the colleague, or back to "New" for anyone to take.
    prisma.bookingRequest.updateMany({
      where: { id: { in: requests.map((r) => r.id) }, claimedById: fromUserId },
      data: to ? { claimedById: to.id, claimedAt: new Date() } : { claimedById: null, claimedAt: null, status: "NEW" },
    }),
  ]);

  for (const c of chats) {
    emitToNumber(c.whatsappNumberId, "conversation.assigned", { conversationId: c.id, agentId: to ? to.id : null, agentUsername: to ? to.username : null });
    emitToNumber(c.whatsappNumberId, "conversation.updated", { conversationId: c.id });
  }
  for (const r of requests) {
    emitToNumber(r.whatsappNumberId, "booking_request.updated", { requestId: r.id, conversationId: r.conversationId, status: to ? "IN_PROGRESS" : "NEW" });
  }
  if (chats.length || requests.length) {
    logAudit({
      action: "user.handed_over",
      actor,
      targetType: "user",
      targetId: fromUserId,
      details: { to: to ? { id: to.id, username: to.username } : null, chats: chats.length, bookingRequests: requests.length, reason },
    });
  }
  return { chats: chats.length, bookingRequests: requests.length, to: to ? { id: to.id, name: to.name, username: to.username } : null };
}

// Anything this person has done that history points at — such an account is
// deactivated, never deleted (deleting would blank who replied, who booked…).
async function hasHistory(userId) {
  const checks = await Promise.all([
    prisma.message.count({ where: { senderId: userId } }),
    prisma.conversation.count({ where: { OR: [{ assignedAgentId: userId }, { outcomeById: userId }] } }),
    prisma.booking.count({ where: { createdById: userId } }),
    prisma.bookingRequest.count({ where: { OR: [{ claimedById: userId }, { handledById: userId }, { createdById: userId }] } }),
    prisma.conversationNote.count({ where: { authorId: userId } }),
    prisma.campaign.count({ where: { OR: [{ createdById: userId }, { submittedById: userId }, { reviewedById: userId }] } }),
    prisma.flow.count({ where: { createdById: userId } }),
  ]);
  return checks.some((n) => n > 0);
}

module.exports = { handOver, hasHistory };
