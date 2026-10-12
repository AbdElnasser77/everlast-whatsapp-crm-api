// Who is waiting for a reply, and since when.
//
// Conversation.awaitingReplySince is the moment a patient started waiting for
// a person: their first message since someone last answered them. Kept up to
// date at every place a message is written, so "replied and no follow-up" is a
// cheap query instead of a scan of every chat's history:
//
//   patient writes            → set it (only if not already waiting)
//   staff member replies      → clear it; lastAgentReplyAt = now
//   flow bot replies          → clear it (the patient is talking to the bot)
//   flow hands to the team    → set it (now they are waiting for a person)
//   campaign message          → leave it (a broadcast isn't an answer)
//   chat resolved             → ignored by every "waiting" query

const prisma = require("../config/prisma");

// Fields to merge into the conversation update the webhook already makes for
// an inbound message.
const patientWroteData = (conversation, at = new Date()) =>
  conversation.awaitingReplySince ? {} : { awaitingReplySince: at };

async function staffReplied(conversationId, at = new Date()) {
  await prisma.conversation.updateMany({
    where: { id: conversationId },
    data: { awaitingReplySince: null, lastAgentReplyAt: at },
  });
}

async function botReplied(conversationId) {
  await prisma.conversation.updateMany({
    where: { id: conversationId },
    data: { awaitingReplySince: null },
  });
}

async function handedToTeam(conversationId, at = new Date()) {
  await prisma.conversation.updateMany({
    where: { id: conversationId, awaitingReplySince: null },
    data: { awaitingReplySince: at },
  });
}

module.exports = { patientWroteData, staffReplied, botReplied, handedToTeam };
