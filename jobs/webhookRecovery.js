const cron = require("node-cron");
const prisma = require("../config/prisma");
const { processWebhookEvent } = require("../modules/webhooks/webhook.controller");

// Re-handles Meta webhook deliveries that were saved but never finished — the
// process died mid-handling, or handling threw (database blip). Meta already
// got its 200 for these and will not send them again, so this is their only
// second chance. Handling is idempotent, so a re-run never duplicates.
//
// A delivery is left alone for a while first (it may still be in progress in
// the request that saved it) and given up on after MAX_ATTEMPTS, so a payload
// that always fails can't be retried forever. Given-up rows keep their
// lastError for diagnosis.

const MAX_ATTEMPTS = 5;
const GRACE_MS = Number(process.env.WEBHOOK_RECOVERY_GRACE_MS) || 2 * 60 * 1000;
const BATCH = 50;
const KEEP_DAYS = 7;

async function recoverWebhookEvents({ ids } = {}) {
  const events = await prisma.webhookEvent.findMany({
    where: {
      processedAt: null,
      attempts: { lt: MAX_ATTEMPTS },
      ...(ids ? { id: { in: ids } } : { receivedAt: { lt: new Date(Date.now() - GRACE_MS) } }),
    },
    orderBy: { id: "asc" },
    take: BATCH,
  });
  let recovered = 0;
  for (const event of events) {
    // In order, one at a time: the deliveries of one chat must be handled in
    // the order Meta sent them.
    if (await processWebhookEvent(event)) recovered++;
    else if (event.attempts + 1 >= MAX_ATTEMPTS) {
      console.error(`[Webhooks] giving up on event ${event.id} after ${MAX_ATTEMPTS} attempts — see its lastError`);
    }
  }
  if (events.length) console.log(`[Webhooks] recovery: ${recovered}/${events.length} unfinished deliveries handled`);
  return { checked: events.length, recovered };
}

// Handled deliveries are only kept as a short audit trail.
async function pruneWebhookEvents() {
  const { count } = await prisma.webhookEvent.deleteMany({
    where: { processedAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } },
  });
  if (count) console.log(`[Webhooks] pruned ${count} handled deliveries older than ${KEEP_DAYS} days`);
}

function startWebhookRecovery() {
  cron.schedule("* * * * *", () => {
    recoverWebhookEvents().catch((err) => console.error("[Webhooks] recovery failed:", err.message));
  });
  cron.schedule("17 3 * * *", () => {
    pruneWebhookEvents().catch((err) => console.error("[Webhooks] prune failed:", err.message));
  });
  console.log("[Webhooks] recovery started (every minute)");
}

module.exports = { startWebhookRecovery, recoverWebhookEvents, pruneWebhookEvents };
