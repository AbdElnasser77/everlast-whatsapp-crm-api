const cron = require("node-cron");
const prisma = require("../config/prisma");
const { processCampaign } = require("../modules/campaigns/campaign.controller");
const { isQuietHours } = require("../utils/quietHours");
const logAudit = require("../utils/audit");

function startCampaignScheduler() {
  // Recover campaigns left in RUNNING by a crash/restart. processCampaign only
  // sends to recipients still marked PENDING, so resuming is safe and idempotent.
  // NOTE: assumes a single server instance (as does node-cron below).
  (async () => {
    try {
      const stuck = await prisma.campaign.findMany({
        where: { status: "RUNNING" },
        select: { id: true },
      });
      for (const c of stuck) {
        console.log(`[Scheduler] Resuming interrupted campaign ${c.id}`);
        processCampaign(c.id).catch((err) =>
          console.error(`[Scheduler] Resume of campaign ${c.id} failed:`, err.message)
        );
      }
    } catch (err) {
      console.error("[Scheduler] Failed to recover running campaigns:", err.message);
    }
  })();

  // Recovery above needs no quiet-hours check of its own: processCampaign
  // parks a campaign as PAUSED/QUIET_HOURS if it is started inside the window.

  cron.schedule("* * * * *", async () => {
    // Inside quiet hours nothing starts: due campaigns stay SCHEDULED and go
    // out on the first tick after the window opens.
    if (isQuietHours()) return;

    try {
      // Resume what quiet hours paused — and only that. A campaign a person
      // paused (MANUAL), or whose number went inactive, is left alone.
      const parked = await prisma.campaign.findMany({
        where: { status: "PAUSED", pauseReason: "QUIET_HOURS" },
        select: { id: true, name: true, sentCount: true, totalRecipients: true },
      });
      for (const c of parked) {
        // Status-guarded, like every other transition to RUNNING.
        const { count } = await prisma.campaign.updateMany({
          where: { id: c.id, status: "PAUSED", pauseReason: "QUIET_HOURS" },
          data: { status: "RUNNING", pauseReason: null, pauseDetail: null },
        });
        if (count === 0) continue;
        console.log(`[Scheduler] Quiet hours over — resuming campaign ${c.id}`);
        logAudit({
          action: "CAMPAIGN_AUTO_RESUMED",
          actor: null,
          targetType: "Campaign",
          targetId: c.id,
          details: { name: c.name, reason: "QUIET_HOURS", sentCount: c.sentCount, totalRecipients: c.totalRecipients },
        });
        processCampaign(c.id).catch((err) =>
          console.error(`[Scheduler] Resume of campaign ${c.id} failed:`, err.message)
        );
      }
    } catch (err) {
      console.error("[Scheduler] Error resuming quiet-hours campaigns:", err.message);
    }

    try {
      const due = await prisma.campaign.findMany({
        where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
        select: { id: true },
      });

      for (const c of due) {
        // Status-guarded: a Send-now or Cancel that landed after the findMany
        // must win, or the campaign would start twice / come back to life.
        const { count } = await prisma.campaign.updateMany({
          where: { id: c.id, status: "SCHEDULED" },
          data: { status: "RUNNING", startedAt: new Date() },
        });
        if (count === 0) continue;
        processCampaign(c.id).catch((err) =>
          console.error(`[Scheduler] Campaign ${c.id} failed:`, err.message)
        );
      }
    } catch (err) {
      console.error("[Scheduler] Error checking scheduled campaigns:", err.message);
    }
  });

  console.log("[Scheduler] Campaign scheduler started");
}

module.exports = { startCampaignScheduler };
