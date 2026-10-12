const cron = require("node-cron");
const prisma = require("../config/prisma");
const { processCampaign } = require("../modules/campaigns/campaign.controller");
const { isQuietHours } = require("../utils/quietHours");
const logAudit = require("../utils/audit");

// Carry on campaigns a dead process left RUNNING: crashed, killed, or
// redeployed mid-send. Only campaigns whose send lease has expired (or was
// released) are picked up, so a loop still alive in another instance — say,
// the old process during a rolling deploy — is never doubled.
// processCampaign takes the lease, settles anything left SENDING as "Not
// confirmed" (never resent) and sends the rest.
async function recoverInterruptedCampaigns({ campaignIds } = {}) {
  const stuck = await prisma.campaign.findMany({
    where: {
      status: "RUNNING",
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }],
      ...(campaignIds ? { id: { in: campaignIds } } : {}),
    },
    select: { id: true },
  });
  for (const c of stuck) {
    console.log(`[Scheduler] Resuming interrupted campaign ${c.id}`);
    processCampaign(c.id).catch((err) =>
      console.error(`[Scheduler] Resume of campaign ${c.id} failed:`, err.message)
    );
  }
  return stuck.length;
}

// One scheduler minute: recover interrupted sends, resume automatic pauses
// that are due, start scheduled campaigns that are due. `campaignIds` limits
// it to those campaigns (the checks use it so real campaigns are never touched).
async function schedulerTick({ campaignIds } = {}) {
  const scope = campaignIds ? { id: { in: campaignIds } } : {};
  // Every minute, not just at boot: a lease that expires after startup (an
  // instance that died while this one was already up) is picked up too.
  await recoverInterruptedCampaigns({ campaignIds }).catch((err) =>
    console.error("[Scheduler] Failed to recover running campaigns:", err.message)
  );

  // Inside quiet hours nothing starts: due campaigns stay SCHEDULED and go
  // out on the first tick after the window opens.
  if (isQuietHours()) return;

  try {
    // Resume what the system paused by itself — and only that: quiet hours
    // (the window is open again), and Meta rate limits / connection trouble
    // once their resumeAt has passed. A campaign a person paused (MANUAL),
    // whose number went inactive, or whose template is unusable is left alone.
    const now = new Date();
    const automatic = [
      { pauseReason: "QUIET_HOURS" },
      { pauseReason: { in: ["RATE_LIMIT", "CONNECTION"] }, resumeAt: { lte: now } },
    ];
    const parked = await prisma.campaign.findMany({
      where: { status: "PAUSED", OR: automatic, ...scope },
      select: { id: true, name: true, sentCount: true, totalRecipients: true, pauseReason: true },
    });
    for (const c of parked) {
      // Status-guarded, like every other transition to RUNNING: a person who
      // paused it (MANUAL) in the meantime wins.
      const { count } = await prisma.campaign.updateMany({
        where: { id: c.id, status: "PAUSED", OR: automatic },
        data: { status: "RUNNING", pauseReason: null, pauseDetail: null, resumeAt: null },
      });
      if (count === 0) continue;
      console.log(`[Scheduler] ${c.pauseReason} pause over — resuming campaign ${c.id}`);
      logAudit({
        action: "CAMPAIGN_AUTO_RESUMED",
        actor: null,
        targetType: "Campaign",
        targetId: c.id,
        details: { name: c.name, reason: c.pauseReason, sentCount: c.sentCount, totalRecipients: c.totalRecipients },
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
      where: { status: "SCHEDULED", scheduledAt: { lte: new Date() }, ...scope },
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
}

function startCampaignScheduler() {
  recoverInterruptedCampaigns().catch((err) =>
    console.error("[Scheduler] Failed to recover running campaigns:", err.message)
  );

  // Recovery needs no quiet-hours check of its own: processCampaign parks a
  // campaign as PAUSED/QUIET_HOURS if it is started inside the window.

  cron.schedule("* * * * *", () => schedulerTick());

  console.log("[Scheduler] Campaign scheduler started");
}

module.exports = { startCampaignScheduler, recoverInterruptedCampaigns, schedulerTick };
