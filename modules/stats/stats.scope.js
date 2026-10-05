// Number scoping for the stats queries.
//
// Twenty-two queries live in stats.controller.js. Hand-rolling the filter in
// each one is how the twenty-third gets added without it, so every query goes
// through a helper here instead.
//
// This router accepts `X-WhatsApp-Number-Id: all`, which sets req.numberScope
// to "ALL" — an owner looking at the whole business rather than one line. Each
// helper degrades to "no filter" in that case.

const { Prisma } = require("@prisma/client");

const isAll = (req) => req.numberScope === "ALL" || !req.numberId;

// For queries on Conversation.
const conversationWhere = (req) =>
  isAll(req) ? {} : { whatsappNumberId: req.numberId };

// For queries on Message. Message has no number column of its own — it reaches
// one through its conversation, which keeps the largest table normalized.
const messageWhere = (req) =>
  isAll(req) ? {} : { conversation: { whatsappNumberId: req.numberId } };

// For raw SQL. Returns a fragment to splice into a WHERE, e.g.
//   WHERE m."createdAt" >= ${since} ${sqlNumberFilter(req, "conv")}
// Always pair it with the join below so there is one SQL string and one code
// path, rather than a scoped and an unscoped variant that can drift.
const sqlNumberFilter = (req, alias) =>
  isAll(req)
    ? Prisma.empty
    : Prisma.sql`AND ${Prisma.raw(`"${alias}"`)}."whatsappNumberId" = ${req.numberId}`;

// Joins Conversation so a Message query can be filtered by number. Emitted
// unconditionally: the planner cost is negligible against the existing
// @@index([conversationId, createdAt]), and one SQL shape is worth more than a
// micro-optimisation.
const sqlConversationJoin = (alias, messageAlias) =>
  Prisma.sql`JOIN "Conversation" ${Prisma.raw(`"${alias}"`)} ON ${Prisma.raw(`"${alias}"`)}.id = ${Prisma.raw(`"${messageAlias}"`)}."conversationId"`;

// Echoed on every stats response so the dashboard can label which figures are
// scoped and which are global, instead of silently implying that customer and
// agent counts follow the switcher.
const scopeMeta = (req) => ({
  scope: isAll(req) ? "ALL" : "NUMBER",
  whatsappNumberId: isAll(req) ? null : req.numberId,
});

module.exports = {
  isAll,
  conversationWhere,
  messageWhere,
  sqlNumberFilter,
  sqlConversationJoin,
  scopeMeta,
};
