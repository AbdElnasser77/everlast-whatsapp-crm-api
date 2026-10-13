const cron = require("node-cron");
const prisma = require("../config/prisma");
const { emitToUser, emitToNumberStaff } = require("../utils/socket");

// "Follow up" used to rely on someone remembering. Every few minutes, chats
// whose follow-up time has come get one reminder: to the agent who owns the
// chat (or who set the follow-up); if nobody owns it, to everyone on that
// line. followUpNotifiedAt makes it once per follow-up date (setting a new
// date resets it).

async function sendFollowUpReminders() {
  const due = await prisma.conversation.findMany({
    where: { outcome: "FOLLOW_UP", followUpAt: { lte: new Date() }, followUpNotifiedAt: null },
    select: {
      id: true, whatsappNumberId: true, followUpAt: true, assignedAgentId: true, outcomeById: true,
      customer: { select: { name: true, phone: true } },
    },
    take: 200,
  });
  for (const c of due) {
    const { count } = await prisma.conversation.updateMany({
      where: { id: c.id, followUpNotifiedAt: null, followUpAt: c.followUpAt },
      data: { followUpNotifiedAt: new Date() },
    });
    if (count === 0) continue; // another process sent it, or the date changed
    const payload = {
      conversationId: c.id,
      whatsappNumberId: c.whatsappNumberId,
      followUpAt: c.followUpAt,
      customerName: c.customer.name,
      customerPhone: c.customer.phone,
    };
    const owner = c.assignedAgentId || c.outcomeById;
    if (owner) emitToUser(owner, "follow_up.due", payload);
    else await emitToNumberStaff(c.whatsappNumberId, "follow_up.due", payload);
  }
  return due.length;
}

function startFollowUpReminders() {
  cron.schedule("*/5 * * * *", () => {
    sendFollowUpReminders().catch((err) => console.error("[FollowUps] reminders failed:", err.message));
  });
  console.log("[FollowUps] reminders started (every 5 min)");
}

module.exports = { startFollowUpReminders, sendFollowUpReminders };
