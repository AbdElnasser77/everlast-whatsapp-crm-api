const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { emitToNumber } = require("../../utils/socket");

// Agents record a patient's opt-out from the chat (the patient said "don't
// send me offers" on a call, in person, or in their own words). Two scopes:
//   line — no campaigns from THIS WhatsApp line (a CustomerOptOut, source MANUAL)
//   all  — the global do-not-contact switch (Customer.optedOut)
// Lifting an opt-out is a separate permission (optout:lift, admins only):
// consent is easy to give away and must not be easy to take back by mistake.

const SCOPES = ["line", "all"];

async function loadConversation(req) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: parseInt(req.params.id), whatsappNumberId: req.numberId },
    include: { customer: { select: { id: true, optedOut: true } } },
  });
  if (!conversation) throw new AppError("Conversation not found", 404);
  return conversation;
}

async function optOutState(conversation) {
  const [line, customer] = await Promise.all([
    prisma.customerOptOut.findUnique({
      where: { customerId_whatsappNumberId: { customerId: conversation.customerId, whatsappNumberId: conversation.whatsappNumberId } },
      select: { optedOutAt: true, source: true },
    }),
    prisma.customer.findUnique({ where: { id: conversation.customerId }, select: { optedOut: true } }),
  ]);
  return { line, all: Boolean(customer?.optedOut) };
}

const announce = (conversation) => {
  emitToNumber(conversation.whatsappNumberId, "conversation.updated", { conversationId: conversation.id });
  emitToNumber(conversation.whatsappNumberId, "customer.opt_out_changed", { conversationId: conversation.id, customerId: conversation.customerId });
};

// ─── POST /api/conversations/:id/opt-out { scope: "line" | "all", reason? } ──
const optOut = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const scope = SCOPES.includes(req.body?.scope) ? req.body.scope : null;
    if (!scope) return next(new AppError('Choose "this line" or "all lines"', 400));
    const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 300) : null;
    if (scope === "line") {
      await prisma.customerOptOut.upsert({
        where: { customerId_whatsappNumberId: { customerId: conversation.customerId, whatsappNumberId: conversation.whatsappNumberId } },
        update: {},
        create: { customerId: conversation.customerId, whatsappNumberId: conversation.whatsappNumberId, source: "MANUAL" },
      });
    } else {
      await prisma.customer.update({ where: { id: conversation.customerId }, data: { optedOut: true } });
    }
    logAudit({
      action: "CUSTOMER_OPTED_OUT",
      actor: req.user,
      targetType: "Customer",
      targetId: conversation.customerId,
      details: { source: "MANUAL", scope, whatsappNumberId: conversation.whatsappNumberId, conversationId: conversation.id, reason },
    });
    announce(conversation);
    res.status(200).json({ success: true, data: await optOutState(conversation) });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/conversations/:id/opt-out?scope=line|all ──────────────────
// optout:lift (admins). Lifts any source — including a STOP the patient sent —
// so it is audited with what was removed.
const liftOptOut = async (req, res, next) => {
  try {
    const conversation = await loadConversation(req);
    const scope = SCOPES.includes(req.query?.scope) ? req.query.scope : null;
    if (!scope) return next(new AppError('Choose "line" or "all"', 400));
    let removed = null;
    if (scope === "line") {
      const existing = await prisma.customerOptOut.findUnique({
        where: { customerId_whatsappNumberId: { customerId: conversation.customerId, whatsappNumberId: conversation.whatsappNumberId } },
      });
      if (!existing) return next(new AppError("This patient isn't opted out on this line", 404));
      await prisma.customerOptOut.delete({ where: { id: existing.id } });
      removed = { source: existing.source, optedOutAt: existing.optedOutAt };
    } else {
      if (!conversation.customer.optedOut) return next(new AppError("This patient isn't opted out of all lines", 404));
      await prisma.customer.update({ where: { id: conversation.customerId }, data: { optedOut: false } });
    }
    logAudit({
      action: "CUSTOMER_OPTED_IN",
      actor: req.user,
      targetType: "Customer",
      targetId: conversation.customerId,
      details: { source: "MANUAL", scope, whatsappNumberId: conversation.whatsappNumberId, removed },
    });
    announce(conversation);
    res.status(200).json({ success: true, data: await optOutState(conversation) });
  } catch (err) {
    next(err);
  }
};

module.exports = { optOut, liftOptOut, optOutState };
