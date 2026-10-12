const cron = require("node-cron");
const axios = require("axios");
const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const { getApiVersion } = require("../utils/whatsappClient");
const { emitGlobal, emitToNumber } = require("../utils/socket");
const { qualityProblem } = require("../utils/campaignPreflight");
const logAudit = require("../utils/audit");

// Watches each number's health at Meta: the quality rating (GREEN / YELLOW /
// RED, driven by blocks and reports) and the account status (CONNECTED /
// FLAGGED / RESTRICTED / BANNED). A falling rating is Meta's warning before it
// limits or bans a number, so when Settings → Campaign safety says so, the
// number's running campaigns are paused and admins are alerted — instead of
// someone noticing on the Number Health page days later.

const RANK = { GREEN: 0, UNKNOWN: 0, YELLOW: 1, RED: 2 };

async function checkNumberQuality({ numberIds } = {}) {
  const list = await prisma.whatsAppNumber.findMany({
    where: { isActive: true, ...(numberIds ? { id: { in: numberIds } } : {}) },
  });
  const results = [];
  for (const number of list) {
    let qualityRating = null;
    let metaStatus = null;
    try {
      const { phoneNumberId, accessToken } = await numbers.getCredentials(number);
      const { data } = await axios.get(`https://graph.facebook.com/${getApiVersion()}/${phoneNumberId}`, {
        params: { fields: "quality_rating,status" },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10_000,
      });
      qualityRating = data.quality_rating || null;
      metaStatus = data.status || null;
    } catch (err) {
      console.error(`[Quality] could not read "${number.label}":`, err.response?.data?.error?.message || err.message);
      results.push({ numberId: number.id, error: true });
      continue;
    }

    const updated = await prisma.whatsAppNumber.update({
      where: { id: number.id },
      data: { qualityRating, metaStatus, qualityCheckedAt: new Date() },
    });
    numbers.invalidate();

    const worse = (RANK[qualityRating] ?? 0) > (RANK[number.qualityRating] ?? 0) || (metaStatus !== number.metaStatus && metaStatus && metaStatus !== "CONNECTED");
    const problem = qualityProblem(updated);
    let paused = 0;
    if (problem) {
      const running = await prisma.campaign.findMany({
        where: { whatsappNumberId: number.id, status: "RUNNING" },
        select: { id: true },
      });
      for (const c of running) {
        const { count } = await prisma.campaign.updateMany({
          where: { id: c.id, status: "RUNNING" },
          data: { status: "PAUSED", pauseReason: "QUALITY", pauseDetail: problem },
        });
        if (count === 0) continue;
        paused++;
        emitToNumber(number.id, "campaign.paused", { campaignId: c.id, reason: "QUALITY", detail: problem });
        logAudit({
          action: "CAMPAIGN_PAUSED",
          actor: null,
          targetType: "Campaign",
          targetId: c.id,
          details: { reason: "QUALITY", detail: problem },
        });
      }
    }
    if (worse) {
      console.warn(`[Quality] "${number.label}" is now ${qualityRating} / ${metaStatus} (was ${number.qualityRating} / ${number.metaStatus}) — ${paused} campaign(s) paused`);
      emitGlobal("number.quality_changed", {
        numberId: number.id,
        label: number.label,
        qualityRating,
        metaStatus,
        previousRating: number.qualityRating,
        campaignsPaused: paused,
        held: Boolean(problem),
      });
      logAudit({
        action: "NUMBER_QUALITY_DROPPED",
        actor: null,
        targetType: "WhatsAppNumber",
        targetId: number.id,
        details: { label: number.label, qualityRating, metaStatus, previousRating: number.qualityRating, campaignsPaused: paused },
      });
    }
    results.push({ numberId: number.id, qualityRating, metaStatus, held: Boolean(problem), campaignsPaused: paused });
  }
  return results;
}

function startNumberQualityWatch() {
  cron.schedule("*/30 * * * *", () => {
    checkNumberQuality().catch((err) => console.error("[Quality] watch failed:", err.message));
  });
  // Once at startup too, so the preflight has a rating to judge by.
  checkNumberQuality().catch((err) => console.error("[Quality] first check failed:", err.message));
  console.log("[Quality] number quality watch started (every 30 min)");
}

module.exports = { startNumberQualityWatch, checkNumberQuality };
