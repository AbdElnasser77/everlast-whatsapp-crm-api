// Meta's messaging limit: how many DIFFERENT people a number may start
// conversations with (template messages) in a rolling 24 hours — 250, 1K,
// 10K, 100K or unlimited, raised automatically as the number earns it. Sends
// past the limit fail at Meta, so a campaign bigger than what is left today
// is flagged before it starts.
//
// "Used" is counted from our own records (people this number sent a template
// to in the last 24 hours), so it is an estimate: messages sent from outside
// the CRM aren't seen. Someone already messaged today doesn't count twice —
// Meta counts unique people.

const axios = require("axios");
const prisma = require("../config/prisma");
const numbers = require("./whatsappNumbers");
const { getApiVersion } = require("./whatsappClient");

const TIER_LIMITS = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  TIER_UNLIMITED: Infinity,
};
const TIER_CACHE_MS = 60 * 60 * 1000;
const tierCache = new Map(); // numberId -> { tier, at }

// The number's tier as Meta reports it, or null when Meta can't be asked
// (then nothing is blocked — the check is a warning, not a gate).
async function getTier(number) {
  const cached = tierCache.get(number.id);
  if (cached && Date.now() - cached.at < TIER_CACHE_MS) return cached.tier;
  try {
    const { phoneNumberId, accessToken } = await numbers.getCredentials(number);
    const res = await axios.get(`https://graph.facebook.com/${getApiVersion()}/${phoneNumberId}`, {
      params: { fields: "messaging_limit_tier" },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    const tier = res.data?.messaging_limit_tier || null;
    tierCache.set(number.id, { tier, at: Date.now() });
    return tier;
  } catch (err) {
    console.warn(`[Capacity] could not read messaging tier for "${number.label}":`, err.response?.data?.error?.message || err.message);
    return null;
  }
}

// Capacity for sending `campaignId`'s remaining (PENDING) recipients now.
async function getCampaignCapacity(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { whatsappNumber: true },
  });
  if (!campaign) return null;
  const number = campaign.whatsappNumber;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [usedRow] = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT c."customerId")::int AS used
    FROM "Message" m
    JOIN "Conversation" c ON c.id = m."conversationId"
    WHERE c."whatsappNumberId" = ${number.id}
      AND m."senderType" = 'AGENT'
      AND m."messageType" = 'TEMPLATE'
      AND m."createdAt" >= ${since}
      AND (m.status IS NULL OR m.status <> 'FAILED')`;
  // People in this campaign not already messaged today — only they use up
  // the limit.
  const [neededRow] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS needed
    FROM "CampaignRecipient" r
    WHERE r."campaignId" = ${campaignId}
      AND r.status = 'PENDING'
      AND NOT EXISTS (
        SELECT 1 FROM "Message" m
        JOIN "Conversation" c ON c.id = m."conversationId"
        WHERE c."customerId" = r."customerId"
          AND c."whatsappNumberId" = ${number.id}
          AND m."senderType" = 'AGENT'
          AND m."messageType" = 'TEMPLATE'
          AND m."createdAt" >= ${since}
          AND (m.status IS NULL OR m.status <> 'FAILED')
      )`;

  const tier = await getTier(number);
  const limit = tier && TIER_LIMITS[tier] !== undefined ? TIER_LIMITS[tier] : null;
  const used = usedRow?.used ?? 0;
  const needed = neededRow?.needed ?? 0;
  const remaining = limit === null ? null : limit === Infinity ? null : Math.max(0, limit - used);
  return {
    tier,
    limit: limit === Infinity ? null : limit,
    unlimited: limit === Infinity,
    usedLast24h: used,
    needed,
    remaining,
    overLimit: remaining !== null && needed > remaining,
  };
}

module.exports = { getCampaignCapacity, getTier, TIER_LIMITS, _tierCache: tierCache };
