// Which campaign, if any, an inbound message is answering.
//
// The rule, in order:
//   1. EXACT — the customer used WhatsApp's reply feature, or tapped one of the
//      template's buttons. Either way WhatsApp tells us the id of the message
//      they answered (context.id); if that is a campaign send, that is the
//      campaign. Precise, and linked whenever it happens.
//   2. WINDOW — otherwise, the FIRST message from this customer, on this
//      number, within ATTRIBUTION_WINDOW_DAYS of a campaign reaching them
//      counts as a reply to the most recent such campaign. Most people just
//      type a new message rather than swiping to reply, so rule 1 alone would
//      miss the majority of real replies.
// Only the first message of a reply is linked. Everything after it is the
// ordinary conversation that follows, and `CampaignRecipient.repliedAt` —
// what "Replied" counts — is set once and never moved.

const prisma = require("../config/prisma");

const ATTRIBUTION_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const CAMPAIGN_SELECT = { select: { id: true, campaign: { select: { id: true, name: true } } } };

/**
 * Link an inbound message to the campaign it answers, if any.
 * @returns {Promise<null | { recipientId: number, campaign: { id: number, name: string }, via: "quote" | "window" }>}
 */
async function attributeReply({ messageId, customerId, whatsappNumberId, quotedWhatsappMessageId, now = new Date() }) {
  // 1. Exact: the message they replied to is a campaign send.
  if (quotedWhatsappMessageId) {
    const recipient = await prisma.campaignRecipient.findFirst({
      where: {
        customerId,
        status: "SENT",
        message: { whatsappMessageId: quotedWhatsappMessageId },
        campaign: { whatsappNumberId },
      },
      ...CAMPAIGN_SELECT,
    });
    if (recipient) {
      await prisma.message.update({ where: { id: messageId }, data: { campaignRecipientId: recipient.id } });
      // First reply only sets repliedAt; a later quoted reply is still linked
      // (it provably answers the campaign) but doesn't move the timestamp.
      await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, repliedAt: null },
        data: { repliedAt: now },
      });
      return { recipientId: recipient.id, campaign: recipient.campaign, via: "quote" };
    }
  }

  // 2. Window: their first message after the most recent campaign that reached
  // them on this number, if it arrived within the window.
  const since = new Date(now.getTime() - ATTRIBUTION_WINDOW_DAYS * DAY_MS);
  const recipient = await prisma.campaignRecipient.findFirst({
    where: {
      customerId,
      status: "SENT",
      repliedAt: null,
      sentAt: { gte: since, lte: now },
      campaign: { whatsappNumberId },
    },
    orderBy: { sentAt: "desc" },
    ...CAMPAIGN_SELECT,
  });
  if (!recipient) return null;

  // Claim the "first reply" atomically: if two messages arrive at once, only one
  // of them matches `repliedAt: null`, and only that one is linked.
  const { count } = await prisma.campaignRecipient.updateMany({
    where: { id: recipient.id, repliedAt: null },
    data: { repliedAt: now },
  });
  if (count === 0) return null;

  await prisma.message.update({ where: { id: messageId }, data: { campaignRecipientId: recipient.id } });
  return { recipientId: recipient.id, campaign: recipient.campaign, via: "window" };
}

module.exports = { attributeReply, ATTRIBUTION_WINDOW_DAYS };
