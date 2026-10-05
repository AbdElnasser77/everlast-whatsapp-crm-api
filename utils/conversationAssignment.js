// Who may own a conversation, and the "replying claims it" rule — kept in one
// place so the assign endpoint, the send paths and the assignable-users list
// can never disagree about it.

const prisma = require("../config/prisma");
const { roleHasPermission } = require("../config/permissions");
const { emitToNumber } = require("./socket");
const logAudit = require("./audit");

// The fields every assignment response and socket event carries about the owner.
const ASSIGNEE_SELECT = { id: true, name: true, username: true };

// An owner must be able to actually work the conversation: an active account
// whose role can reply. Decided by permission, never by role name — so an
// admin who can reply is assignable, and a marketing user (read-only inbox) is
// not.
function isAssignable(user) {
  return Boolean(user && user.isActive && roleHasPermission(user.role, "conversation:write"));
}

// Assign an UNASSIGNED conversation to the user replying in it. The WHERE clause
// includes `assignedAgentId: null`, so it is one atomic statement: if two agents
// reply at the same moment, exactly one update matches and the first reply wins —
// the second never overwrites the first. Returns true if this call claimed it.
async function claimIfUnassigned({ conversationId, numberId, user }) {
  if (!roleHasPermission(user.role, "conversation:write")) return false;

  const { count } = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedAgentId: null },
    data: { assignedAgentId: user.id },
  });
  if (count === 0) return false;

  emitToNumber(numberId, "conversation.assigned", {
    conversationId,
    agentId: user.id,
    agentUsername: user.username,
  });
  emitToNumber(numberId, "conversation.updated", { conversationId });

  logAudit({
    action: "conversation.claimed",
    actor: user,
    targetType: "conversation",
    targetId: conversationId,
    details: { agentId: user.id, agentUsername: user.username, reason: "replied while unassigned" },
  });
  return true;
}

module.exports = { ASSIGNEE_SELECT, isAssignable, claimIfUnassigned };
