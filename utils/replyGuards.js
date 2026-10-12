// Rules that keep several agents working one inbox from stepping on each other.
// Shared by every path where a person sends into a chat (text, media,
// templates), so they can't drift apart.

const prisma = require("../config/prisma");
const AppError = require("./AppError");

// ── Duplicate sends ─────────────────────────────────────────────────────────
// The browser gives every message a random id before sending it. A second
// request with the same id — a double-click, Enter pressed twice, a retry after
// a timeout — returns the first message instead of sending it to WhatsApp again.
// Enforced by a unique column, so it holds even for two requests racing.
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readClientMessageId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const id = String(raw);
  if (!CLIENT_ID_RE.test(id)) throw new AppError("clientMessageId must be 8-64 letters, digits, - or _", 400);
  return id;
}

/** The message already sent under this id in this chat, or null. */
async function findDuplicateSend(clientMessageId, conversationId, include) {
  if (!clientMessageId) return null;
  const existing = await prisma.message.findUnique({ where: { clientMessageId }, ...(include ? { include } : {}) });
  if (!existing) return null;
  if (existing.conversationId !== conversationId) {
    // Same id in another chat: never a legitimate retry.
    throw new AppError("This message id was already used in another conversation", 409, "CLIENT_ID_CONFLICT");
  }
  return existing;
}

const isClientIdRace = (err, clientMessageId) =>
  Boolean(clientMessageId) && err?.code === "P2002" && String(err?.meta?.target || "").includes("clientMessageId");

// ── Replying in a colleague's chat ──────────────────────────────────────────
// Allowed — people cover for each other — but never by accident: the sender
// must confirm they mean to reply in a chat someone else owns. The browser asks
// first; this is the check that also catches a screen that was out of date.
function assertMayReply(conversation, user, confirmed) {
  const ownerId = conversation.assignedAgentId ?? conversation.assignedAgent?.id ?? null;
  if (!ownerId || ownerId === user.id || confirmed) return;
  const owner = conversation.assignedAgent;
  const name = owner ? owner.name || owner.username : "another agent";
  throw new AppError(
    `This chat is assigned to ${name}. Confirm to reply anyway.`,
    409,
    "ASSIGNED_TO_OTHER",
    { assignee: owner ? { id: owner.id, name: owner.name ?? null, username: owner.username } : null },
  );
}

module.exports = { readClientMessageId, findDuplicateSend, isClientIdRace, assertMayReply };
