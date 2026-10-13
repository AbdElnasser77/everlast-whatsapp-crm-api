const { Prisma, CampaignCategory } = require("@prisma/client");
const os = require("os");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { sendWhatsAppMessage } = require("../../utils/whatsappClient");
const { emitToNumber } = require("../../utils/socket");
const numbers = require("../../utils/whatsappNumbers");
const { buildTemplateSend } = require("../../utils/templateSend");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const logAudit = require("../../utils/audit");
const { resolveMemberIds } = require("../../utils/segmentFilter");
const { roleHasPermission } = require("../../config/permissions");
const { isQuietHours, nextSendWindowOpen, getQuietHoursConfig } = require("../../utils/quietHours");
const { classifySendError } = require("../../utils/campaignSendErrors");
const { assertCampaignSendable, checkCampaignSendable, isTemplateProblem } = require("../../utils/campaignPreflight");
const { getCampaignCapacity } = require("../../utils/messagingCapacity");
const { getSetting } = require("../../utils/appSettings");

// How many recipients are sent to WhatsApp at once per campaign. Meta's Cloud
// API throughput ceiling per phone number is far above this (tens of
// messages/sec) — the real safety limit for large sends is the number's
// rolling 24h *unique-recipient* messaging tier, which this concurrency
// setting has no effect on either way. 5 keeps DB/connection-pool load
// predictable while still multiplying throughput several times over the old
// fully-sequential loop. Cancellation below only stops *new* recipients from
// starting; in-flight ones in the same batch are allowed to finish.
const CAMPAIGN_SEND_CONCURRENCY = 5;

// Concurrency is capped per NUMBER, not per campaign, because Meta rate-limits
// per phone number. Two campaigns approved on the same line would otherwise run
// CAMPAIGN_SEND_CONCURRENCY lanes each and double the real send rate on that
// number, while two campaigns on different lines are genuinely independent.
//
// Per-number default comes from WhatsAppNumber.sendConcurrency, since numbers at
// different Meta throughput tiers do not deserve the same ceiling.
const numberLanes = new Map();

function acquireLane(numberId, limit) {
  let lane = numberLanes.get(numberId);
  if (!lane) {
    lane = { active: 0, queue: [] };
    numberLanes.set(numberId, lane);
  }
  if (lane.active < limit) {
    lane.active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => lane.queue.push(resolve));
}

function releaseLane(numberId) {
  const lane = numberLanes.get(numberId);
  if (!lane) return;
  const next = lane.queue.shift();
  if (next) return next();
  lane.active--;
  if (lane.active <= 0 && lane.queue.length === 0) numberLanes.delete(numberId);
}

// Pause / cancel requests for a send loop running in THIS process, so the
// lanes stop at once instead of at the next heartbeat. Maps to "CANCELLED" or
// "PAUSED". Only ever set while a loop for that campaign is running here, and
// only ever cleared by resume — a loop never clears it itself, because a
// cancel that lands while the loop is starting up must not be wiped.
// A loop running in another instance learns about the same pause or cancel
// from its heartbeat, which re-reads the campaign row.
const campaignStopSignals = new Map();

// Campaigns with a send loop running in this process. processCampaign refuses
// to start a second loop for the same campaign; a request that arrives while
// one is finishing is remembered in `rerunRequested` and run right after.
const runningCampaigns = new Set();
const rerunRequested = new Set();

// Send-loop lease (Campaign.lockedBy / lockedUntil). A loop sends only while it
// holds an unexpired lease and renews it every heartbeat; it stops by itself
// once it has gone LEASE_MS * 0.75 without a successful renewal, so by the
// time the lease expires and recovery hands the campaign to another process,
// this one is guaranteed to have stopped picking up recipients.
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const LEASE_MS = Number(process.env.CAMPAIGN_LEASE_MS) || 60_000;
const HEARTBEAT_MS = Number(process.env.CAMPAIGN_HEARTBEAT_MS) || 5_000;

// Why a recipient whose send was interrupted is FAILED instead of retried:
// Meta may already have delivered it, and a second copy is worse than none.
const NOT_CONFIRMED = "Not confirmed — the send was interrupted before Meta answered. Not resent, so they can't get it twice.";

// Set by beginShutdown() on SIGTERM: lanes stop picking up recipients, the
// campaign stays RUNNING and the next process carries on from the database.
let shuttingDown = false;

// How the loop reacts to failed sends (see utils/campaignSendErrors.js).
// Backoff for errors that provably weren't delivered; overridable so the
// checks can run in seconds.
const RETRY_DELAYS_MS = (process.env.CAMPAIGN_RETRY_DELAYS_MS || "2000,10000,30000").split(",").map(Number);
// Claims of one recipient before a recipient-looking error is final for them.
const MAX_ATTEMPTS = 3;
// Recipients in a row failing the same "might be the template" way before the
// campaign pauses instead of failing them one by one.
const PROBE_LIMIT = 3;
// Sends in a row with no clear answer from Meta before the campaign pauses.
const CONNECTION_TROUBLE_LIMIT = 3;
// How long someone hit by Meta's per-person rate limit waits for another try.
const REQUEUE_DELAY_MS = Number(process.env.CAMPAIGN_REQUEUE_DELAY_MS) || 60_000;
// When an automatic pause is lifted by the scheduler.
const AUTO_RESUME_MS = {
  RATE_LIMIT: Number(process.env.CAMPAIGN_RATE_LIMIT_RESUME_MS) || 2 * 60_000,
  CONNECTION: Number(process.env.CAMPAIGN_CONNECTION_RESUME_MS) || 5 * 60_000,
};
// Recipients loaded per pass — a 50k audience is never held in memory at once.
const RECIPIENT_PAGE = Number(process.env.CAMPAIGN_RECIPIENT_PAGE) || 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The campaign's counters, recounted from its recipient rows. Increments keep
// the live progress moving; this is what makes the numbers true (a recipient
// deleted with its customer, a status webhook moving SENT to FAILED, skips).
async function recountCampaign(campaignId, numberId) {
  const groups = await prisma.campaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const n = (status) => groups.find((g) => g.status === status)?._count._all || 0;
  const counts = {
    sentCount: n("SENT"),
    failedCount: n("FAILED"),
    skippedCount: n("SKIPPED"),
    totalRecipients: groups.reduce((sum, g) => sum + g._count._all, 0),
  };
  const { count } = await prisma.campaign.updateMany({ where: { id: campaignId }, data: counts });
  if (count && numberId) emitToNumber(numberId, "campaign.progress", { campaignId, ...counts });
  return counts;
}

// A chat that a campaign send created and that ended up with nothing in it.
async function dropEmptyConversation(conversationId) {
  await prisma.conversation
    .deleteMany({ where: { id: conversationId, messages: { none: {} } } })
    .catch(() => {}); // something else got linked to it meanwhile — keep it
}

// Lanes share one index, so no recipient is picked twice in a pass. A worker
// that throws is logged and the lane carries on: one bad recipient must never
// reject Promise.all and leave the campaign RUNNING with nothing behind it.
async function runWithConcurrency(items, limit, getStopSignal, worker) {
  let idx = 0;
  async function lane() {
    while (idx < items.length) {
      if (getStopSignal()) return;
      const item = items[idx++];
      try {
        await worker(item);
      } catch (err) {
        console.error(`[Campaign] recipient ${item && item.id} — unexpected error:`, err.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// Status-guarded so a cancel or manual pause that landed first is not
// overwritten.
async function pauseForQuietHours(campaignId, numberId) {
  const { count } = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "RUNNING" },
    data: { status: "PAUSED", pauseReason: "QUIET_HOURS" },
  });
  if (count === 0) return;
  const resumesAt = nextSendWindowOpen();
  console.log(`[Campaign ${campaignId}] Quiet hours — paused until ${resumesAt.toISOString()}`);
  emitToNumber(numberId, "campaign.paused", { campaignId, reason: "QUIET_HOURS", resumesAt });
}

async function takeLease(campaignId) {
  const now = new Date();
  const { count } = await prisma.campaign.updateMany({
    where: {
      id: campaignId,
      status: "RUNNING",
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }, { lockedBy: INSTANCE_ID }],
    },
    data: { lockedBy: INSTANCE_ID, lockedUntil: new Date(now.getTime() + LEASE_MS) },
  });
  return count === 1;
}

async function releaseLease(campaignId) {
  await prisma.campaign
    .updateMany({ where: { id: campaignId, lockedBy: INSTANCE_ID }, data: { lockedBy: null, lockedUntil: null } })
    .catch((err) => console.error(`[Campaign ${campaignId}] could not release its lease:`, err.message));
}

// Recipients left SENDING by a loop that is no longer running. Only called
// while holding the lease, so no live loop can own them.
//  - No placeholder message yet: the loop died before the Meta call was even
//    attempted (the placeholder is written right before it). Nothing can have
//    been delivered, so they go back to PENDING and are sent normally.
//  - Placeholder written: the Meta call may or may not have gone through, so
//    they are FAILED "Not confirmed" and never resent. The placeholder is
//    marked FAILED too, so the chat doesn't show a message stuck on the clock.
async function settleInterruptedSends(campaignId) {
  const stuck = await prisma.campaignRecipient.findMany({
    where: { campaignId, status: "SENDING" },
    select: { id: true, messageId: true },
  });
  if (stuck.length === 0) return 0;
  const neverCalled = stuck.filter((r) => !r.messageId).map((r) => r.id);
  const maybeSent = stuck.filter((r) => r.messageId);
  if (neverCalled.length) {
    await prisma.campaignRecipient.updateMany({
      where: { id: { in: neverCalled }, status: "SENDING", messageId: null },
      data: { status: "PENDING" },
    });
  }
  if (maybeSent.length === 0) return 0;
  const { count } = await prisma.campaignRecipient.updateMany({
    where: { id: { in: maybeSent.map((r) => r.id) }, status: "SENDING" },
    data: { status: "FAILED", error: NOT_CONFIRMED },
  });
  const messageIds = maybeSent.map((r) => r.messageId);
  await prisma.$transaction([
    prisma.message.updateMany({
      where: { id: { in: messageIds }, whatsappMessageId: null },
      data: { status: "FAILED", errorTitle: "Not confirmed" },
    }),
    prisma.campaign.updateMany({ where: { id: campaignId }, data: { failedCount: { increment: count } } }),
  ]);
  console.warn(`[Campaign ${campaignId}] ${count} interrupted send(s) marked FAILED (not confirmed) — not resent`);
  return count;
}

// ── Exported for scheduler ──────────────────────────────────────────────────

async function processCampaign(campaignId) {
  if (runningCampaigns.has(campaignId)) {
    // A resume that lands while the loop is finishing: run again right after,
    // instead of leaving a RUNNING campaign with no loop behind it.
    rerunRequested.add(campaignId);
    return;
  }
  runningCampaigns.add(campaignId);
  try {
    await runCampaign(campaignId);
  } finally {
    await releaseLease(campaignId);
    runningCampaigns.delete(campaignId);
  }
  if (rerunRequested.delete(campaignId) && !shuttingDown) {
    await processCampaign(campaignId);
  }
}

async function runCampaign(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { template: true, whatsappNumber: true },
  });
  // Only a RUNNING campaign is sent. A cancel or pause that landed before the
  // loop got here is final.
  if (!campaign || campaign.status !== "RUNNING") return;

  const numberId = campaign.whatsappNumberId;

  // Quiet hours. Every send path ends up here (send-now, approve, resume, the
  // cron and crash recovery), so this is the one place the rule is enforced.
  // The campaign is parked as PAUSED/QUIET_HOURS and the scheduler resumes it
  // when the window opens.
  if (isQuietHours()) {
    await pauseForQuietHours(campaignId, numberId);
    return;
  }

  // The number and template are read from the campaign row, never from a
  // request: most entry points into this function (resume, approve, the
  // scheduler, recovery) have no HTTP request to read a header from.
  //
  // A deactivated number or an unusable template pauses the campaign rather
  // than letting every recipient fail the same way — FAILED recipients are not
  // retried on resume, so that would be unrecoverable.
  let credentials;
  try {
    assertCampaignSendable({ template: campaign.template, number: campaign.whatsappNumber });
    credentials = await numbers.getCredentials(campaign.whatsappNumber);
  } catch (err) {
    console.error(`[Campaign ${campaignId}] cannot start:`, err.message);
    const pauseReason =
      err.errorCode === "NUMBER_INACTIVE"
        ? "NUMBER_INACTIVE"
        : err.errorCode === "NUMBER_QUALITY"
          ? "QUALITY"
          : isTemplateProblem(err.errorCode)
            ? "TEMPLATE_UNAVAILABLE"
            : "SEND_ERROR";
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: "RUNNING" },
      data: { status: "PAUSED", pauseReason, pauseDetail: err.message },
    });
    emitToNumber(numberId, "campaign.paused", { campaignId, reason: pauseReason, detail: err.message });
    return;
  }

  // Another process (a second instance, or the one this restart replaced) may
  // still be sending it. Its lease has to expire first.
  if (!(await takeLease(campaignId))) {
    // Either it stopped being RUNNING meanwhile (paused / cancelled), or a
    // live loop elsewhere holds it. Recovery's minute sweep retries the latter.
    console.log(`[Campaign ${campaignId}] not starting — no longer running, or another process holds the send lease`);
    return;
  }
  let lastRenewedAt = Date.now();

  const laneLimit = campaign.whatsappNumber.sendConcurrency || CAMPAIGN_SEND_CONCURRENCY;
  emitToNumber(numberId, "campaign.started", { campaignId });

  // A reason to stop that this loop owns (vs. a pause or cancel by a person).
  let localStop = null;
  let localStopDetail = null;
  const stopWith = (reason, detail) => {
    if (localStop) return;
    localStop = reason;
    localStopDetail = detail;
  };
  // The campaign's status as of the last heartbeat. A pause or cancel handled
  // by another instance reaches this loop through here.
  let observedStatus = "RUNNING";
  const leaseStale = () => Date.now() - lastRenewedAt > LEASE_MS * 0.75;
  const getStopSignal = () =>
    localStop ||
    campaignStopSignals.get(campaignId) ||
    (observedStatus !== "RUNNING" ? observedStatus : null) ||
    (isQuietHours() ? "QUIET_HOURS" : null) ||
    (shuttingDown ? "SHUTDOWN" : null) ||
    (leaseStale() ? "LEASE_LOST" : null);

  // Error bookkeeping for this run (see utils/campaignSendErrors.js).
  // Connection trouble in a row (retries exhausted, or "not confirmed"): a
  // few means Meta is unreachable, and carrying on would burn the audience.
  let connectionTrouble = 0;
  // Sends between claim and outcome. After any connection trouble, sends go
  // one at a time until one succeeds — otherwise the other lanes keep starting
  // sends into the outage, and each of those can end "Not confirmed".
  let inFlight = 0;
  // PROBE failures since the last success: recipients put back as suspects.
  // A success proves the problem was theirs (they are failed individually);
  // PROBE_LIMIT in a row with no success means it's the template/account.
  let suspects = [];
  // Recipients Meta asked us to slow down for (pair rate limit): id → not before.
  const deferred = new Map();

  let progressDirty = false;

  // The lease is renewed on its own timer: queued behind the status read and
  // the progress recount (which wait on the same campaign row as every send),
  // a renewal could slip long enough for the loop to stop itself.
  let renewing = false;
  const renewal = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await prisma.campaign.updateMany({
        where: { id: campaignId, lockedBy: INSTANCE_ID },
        data: { lockedUntil: new Date(Date.now() + LEASE_MS) },
      });
      if (renewed.count === 1) lastRenewedAt = Date.now();
    } catch (err) {
      console.error(`[Campaign ${campaignId}] lease renewal failed:`, err.message);
    } finally {
      renewing = false;
    }
  }, HEARTBEAT_MS);

  let beating = false;
  const heartbeat = setInterval(async () => {
    if (beating) return;
    beating = true;
    try {
      const row = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { status: true, lockedBy: true, whatsappNumber: { select: { isActive: true } } },
      });
      if (!row) {
        observedStatus = "DELETED";
      } else {
        observedStatus = row.status;
        if (row.lockedBy !== INSTANCE_ID) stopWith("LEASE_LOST");
        if (!row.whatsappNumber.isActive) stopWith("NUMBER_INACTIVE", "The WhatsApp number was deactivated while sending");
      }
      if (progressDirty) {
        progressDirty = false;
        await recountCampaign(campaignId, numberId);
      }
    } catch (err) {
      console.error(`[Campaign ${campaignId}] heartbeat failed:`, err.message);
    } finally {
      beating = false;
    }
  }, HEARTBEAT_MS);

  // Put a claimed recipient back as never sent: Meta refused the request, so
  // nothing was delivered. Their placeholder message goes, and so does the
  // chat if this send is what created it.
  const undoClaim = async (recipient, message, createdConversation) => {
    await prisma.message.deleteMany({ where: { id: message.id } });
    await prisma.campaignRecipient.updateMany({
      where: { id: recipient.id, status: "SENDING" },
      data: { status: "PENDING", messageId: null },
    });
    if (createdConversation) await dropEmptyConversation(createdConversation);
  };

  // Mark a claimed recipient FAILED. A placeholder in a chat this send created
  // is removed with the chat — a failed campaign must not leave the inbox
  // full of empty conversations. In an existing chat the failed message stays,
  // so the team can see the attempt.
  const failClaim = async (recipient, message, createdConversation, reason, { code = null, keepMessage = false } = {}) => {
    if (createdConversation && !keepMessage) {
      await prisma.message.deleteMany({ where: { id: message.id } });
      await dropEmptyConversation(createdConversation);
    } else {
      await prisma.message.updateMany({
        where: { id: message.id },
        data: { status: "FAILED", errorCode: code, errorTitle: reason.slice(0, 190) },
      });
    }
    const { count } = await prisma.campaignRecipient.updateMany({
      where: { id: recipient.id, status: "SENDING" },
      data: { status: "FAILED", error: reason },
    });
    if (count) {
      await prisma.campaign.updateMany({ where: { id: campaignId }, data: { failedCount: { increment: 1 } } });
      progressDirty = true;
    }
  };

  const sendOne = async (recipient) => {
    await acquireLane(numberId, laneLimit);
    try {
      // Waiting for a slot on a busy number can take a while; a pause or
      // cancel that landed meanwhile still applies.
      if (getStopSignal()) return;
      while (connectionTrouble > 0 && inFlight > 0 && !getStopSignal()) await sleep(100);
      if (getStopSignal()) return;
      inFlight++;
      try {

      // Claim. From here on this recipient is never sent again by anyone: a
      // crash leaves it SENDING, which recovery settles as "Not confirmed".
      const claimed = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, status: "PENDING" },
        data: { status: "SENDING", claimedAt: new Date(), attempts: { increment: 1 } },
      });
      if (claimed.count === 0) return;

      try {
        await sendClaimed(recipient);
      } catch (err) {
        // Anything unexpected before the Meta call (a database error, a
        // conversation that can't be created). Never sent.
        console.error(`[Campaign ${campaignId}] recipient ${recipient.id} failed:`, err.message);
        try {
          const { count } = await prisma.campaignRecipient.updateMany({
            where: { id: recipient.id, status: "SENDING" },
            data: { status: "FAILED", error: err.message },
          });
          if (count) {
            await prisma.campaign.updateMany({ where: { id: campaignId }, data: { failedCount: { increment: 1 } } });
            progressDirty = true;
          }
        } catch (writeErr) {
          // Left SENDING; the next recovery settles it.
          console.error(`[Campaign ${campaignId}] could not record failure of recipient ${recipient.id}:`, writeErr.message);
        }
      }
      } finally {
        inFlight--;
      }
    } finally {
      releaseLane(numberId);
    }
  };

  // Meta call with backoff for errors that provably weren't delivered.
  const callMeta = async (args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { whatsappMessageId } = await sendWhatsAppMessage(args);
        return { whatsappMessageId };
      } catch (err) {
        const verdict = classifySendError(err);
        const retryable = verdict.kind === "RETRY" || verdict.kind === "RATE_LIMIT";
        if (retryable && attempt < RETRY_DELAYS_MS.length && !getStopSignal()) {
          console.warn(`[Campaign ${campaignId}] ${verdict.reason} — retrying in ${RETRY_DELAYS_MS[attempt]}ms`);
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return { err, verdict };
      }
    }
  };

  const sendClaimed = async (recipient) => {
    // Read fresh at send time, not when the loop started: a do-not-contact
    // flag or phone change made mid-campaign applies to the next send. Two
    // consent checks, deliberately. optedOut is a global do-not-contact
    // switch; a CustomerOptOut row is a STOP sent to THIS line specifically.
    // Either one suppresses the send.
    const customer = await prisma.customer.findUnique({
      where: { id: recipient.customerId },
      include: { optOuts: { where: { whatsappNumberId: numberId }, select: { id: true } } },
    });
    if (!customer) return; // deleted mid-campaign — its recipient row went with it
    if (customer.optedOut || customer.optOuts.length > 0) {
      await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, status: "SENDING" },
        data: { status: "SKIPPED", error: "Opted out" },
      });
      progressDirty = true;
      return;
    }

    // Settings → Campaign safety: at most one campaign per person on this
    // number every N days. Being messaged too often is what makes people
    // block or report a number, and that is what gets it restricted.
    const { frequencyCapDays } = getSetting("campaignSafety");
    if (frequencyCapDays > 0) {
      const recent = await prisma.campaignRecipient.findFirst({
        where: {
          customerId: recipient.customerId,
          status: "SENT",
          campaignId: { not: campaignId },
          sentAt: { gte: new Date(Date.now() - frequencyCapDays * 24 * 60 * 60 * 1000) },
          campaign: { whatsappNumberId: numberId },
        },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true, campaign: { select: { name: true } } },
      });
      if (recent) {
        await prisma.campaignRecipient.updateMany({
          where: { id: recipient.id, status: "SENDING" },
          data: {
            status: "SKIPPED",
            error: `Got "${recent.campaign.name}" on ${recent.sentAt.toISOString().slice(0, 10)} — limit is one campaign every ${frequencyCapDays} day(s)`,
          },
        });
        progressDirty = true;
        return;
      }
    }

    // Get or create the conversation for THIS number. Upsert rather than
    // find-then-create: two campaigns on different numbers targeting the same
    // customer make that race genuinely reachable. The inbox is only told
    // about a new chat once the send has gone through.
    const existed = await prisma.conversation.findUnique({
      where: {
        customerId_whatsappNumberId: { customerId: recipient.customerId, whatsappNumberId: numberId },
      },
      select: { id: true },
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        customerId_whatsappNumberId: { customerId: recipient.customerId, whatsappNumberId: numberId },
      },
      update: {},
      create: {
        customerId: recipient.customerId,
        whatsappNumberId: numberId,
        status: "OPEN",
        unreadCount: 0,
      },
      include: { assignedAgent: { select: { id: true, name: true, username: true } } },
    });
    const createdConversation = existed ? null : conversation.id;

    // Shared with the test-send endpoint so a test proves something about
    // the real send. See utils/templateSend.js.
    const { resolvedBody, templateContent, sendArgs } = buildTemplateSend(campaign.template, customer, null);

    // Linked to the recipient in the same write, so recovery can find (and
    // mark) the placeholder of a send that was interrupted.
    let message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: "AGENT",
        senderId: null,
        content: templateContent,
        // Was hardcoded to INTERACTIVE, which mislabelled every TEMPLATE and
        // TEXT send. The frontend keys its renderer off this field.
        messageType: sendArgs.messageType,
        status: "PENDING",
        sentForRecipients: { connect: { id: recipient.id } },
      },
    });

    const result = await callMeta({ number: credentials, to: customer.phone, ...sendArgs });

    if (result.err) {
      const { err, verdict } = result;
      console.error(`[Campaign ${campaignId}] send to customer ${customer.id} failed (${verdict.kind}):`, err.response?.data || err.message);
      const attempts = (await prisma.campaignRecipient.findUnique({ where: { id: recipient.id }, select: { attempts: true } }))?.attempts ?? 1;

      switch (verdict.kind) {
        case "RETRY":
        case "RATE_LIMIT": {
          // Not delivered, and retries didn't help: back to PENDING, and the
          // campaign pauses and resumes itself. Never burned.
          await undoClaim(recipient, message, createdConversation);
          connectionTrouble++;
          stopWith(verdict.kind === "RATE_LIMIT" ? "RATE_LIMIT" : "CONNECTION", verdict.reason);
          return;
        }
        case "AMBIGUOUS": {
          // May have been delivered: never retried.
          await failClaim(recipient, message, createdConversation, `${NOT_CONFIRMED} (${verdict.reason})`, { keepMessage: true });
          // Kept: it may have reached them, so the chat has to exist.
          if (createdConversation) emitToNumber(numberId, "conversation.created", { conversationId: conversation.id });
          connectionTrouble++;
          if (connectionTrouble >= CONNECTION_TROUBLE_LIMIT) {
            stopWith("CONNECTION", `${connectionTrouble} sends in a row got no clear answer from Meta (${verdict.reason})`);
          }
          return;
        }
        case "REQUEUE": {
          if (attempts >= MAX_ATTEMPTS) {
            await failClaim(recipient, message, createdConversation, verdict.reason, { code: verdict.code });
            return;
          }
          // Too many messages to this one person just now. Try them again
          // later in the run; everyone else carries on.
          await undoClaim(recipient, message, createdConversation);
          deferred.set(recipient.id, Date.now() + REQUEUE_DELAY_MS);
          return;
        }
        case "RECIPIENT": {
          if (verdict.code === 131050) {
            // They turned off marketing in WhatsApp: remembered, so no
            // campaign tries them again.
            await prisma.customerOptOut
              .upsert({
                where: { customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: numberId } },
                update: {},
                create: { customerId: customer.id, whatsappNumberId: numberId, source: "WHATSAPP" },
              })
              .catch(() => {});
          }
          await failClaim(recipient, message, createdConversation, verdict.reason, { code: verdict.code });
          connectionTrouble = 0;
          return;
        }
        case "PROBE": {
          if (attempts >= MAX_ATTEMPTS) {
            // Tried enough times: it's about this person.
            await failClaim(recipient, message, createdConversation, verdict.reason, { code: verdict.code });
            return;
          }
          await undoClaim(recipient, message, createdConversation);
          suspects.push({ id: recipient.id, reason: verdict.reason });
          if (suspects.length >= PROBE_LIMIT) {
            stopWith("SEND_ERROR", `${verdict.reason} — the same kind of error for ${suspects.length} recipients in a row`);
          }
          return;
        }
        default: {
          // SYSTEMIC: the account, token or template. Not delivered.
          await undoClaim(recipient, message, createdConversation);
          stopWith("SEND_ERROR", verdict.reason);
          return;
        }
      }
    }

    const { whatsappMessageId } = result;

    // Meta's id, the recipient's SENT and the chat preview land together: a
    // status webhook can never find the message without its recipient being
    // SENT, and a crash can never leave a delivered send looking unsent.
    // updateMany throughout, so a customer or campaign deleted mid-send just
    // matches nothing instead of throwing. The campaign row is locked first —
    // the same order a campaign delete takes its locks in (campaign, then its
    // recipients) — or deleting a campaign while sends drain deadlocks.
    const now = new Date();
    const [, , sent] = await prisma.$transaction([
      prisma.campaign.updateMany({ where: { id: campaignId }, data: { sentCount: { increment: 1 } } }),
      prisma.message.updateMany({ where: { id: message.id }, data: { whatsappMessageId, status: "SENT" } }),
      prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, status: "SENDING" },
        data: { status: "SENT", messageId: message.id, sentAt: now },
      }),
      prisma.conversation.updateMany({
        where: { id: conversation.id },
        data: { lastMessage: resolvedBody, lastMessageAt: now, lastSenderType: "AGENT" },
      }),
    ]);
    connectionTrouble = 0;
    if (suspects.length) {
      // Someone else went through, so the suspects' errors were about them.
      const proven = suspects;
      suspects = [];
      for (const s of proven) {
        const { count } = await prisma.campaignRecipient.updateMany({
          where: { id: s.id, status: "PENDING" },
          data: { status: "FAILED", error: s.reason },
        });
        if (count) await prisma.campaign.updateMany({ where: { id: campaignId }, data: { failedCount: { increment: 1 } } });
      }
    }
    if (sent.count === 0) return;
    message = { ...message, whatsappMessageId, status: "SENT" };
    progressDirty = true;

    if (createdConversation) emitToNumber(numberId, "conversation.created", { conversationId: conversation.id });
    emitToNumber(numberId, "message.created", { message, conversationId: conversation.id });
    emitToNumber(numberId, "conversation.updated", { conversationId: conversation.id });
  };

  // Pause this campaign for a reason the loop found itself.
  const pauseFor = async (pauseReason, detail, resumeAt = null) => {
    const { count } = await prisma.campaign.updateMany({
      where: { id: campaignId, status: "RUNNING" },
      data: { status: "PAUSED", pauseReason, pauseDetail: detail || null, resumeAt },
    });
    if (count === 0) return;
    console.error(`[Campaign ${campaignId}] paused (${pauseReason})${resumeAt ? ` until ${resumeAt.toISOString()}` : ""} — ${detail || ""}`);
    emitToNumber(numberId, "campaign.paused", { campaignId, reason: pauseReason, detail, resumesAt: resumeAt });
    logAudit({
      action: "CAMPAIGN_PAUSED",
      actor: null,
      targetType: "Campaign",
      targetId: campaignId,
      details: { reason: pauseReason, detail, resumeAt },
    });
  };

  try {
    // After the heartbeat is running, so a slow settle can't let the lease lapse.
    await settleInterruptedSends(campaignId);

    // Passes over the PENDING recipients, a page at a time. More than one pass
    // also happens when the campaign was resumed while this loop was still
    // draining a pause, or when someone had to be retried later.
    for (let pass = 0; pass < 100_000; pass++) {
      const page = await prisma.campaignRecipient.findMany({
        where: { campaignId, status: "PENDING" },
        select: { id: true, customerId: true },
        orderBy: { id: "asc" },
        take: RECIPIENT_PAGE,
      });
      const due = page.filter((r) => !(deferred.get(r.id) > Date.now()));
      if (due.length > 0) {
        await runWithConcurrency(due, laneLimit, getStopSignal, sendOne);
      } else if (page.length > 0) {
        // Only people we were told to slow down for are left: wait for the
        // first of them, watching for a stop while waiting.
        const until = Math.min(...page.map((r) => deferred.get(r.id) || 0));
        while (Date.now() < until && !getStopSignal()) await sleep(Math.min(1000, until - Date.now()));
      }

      const local = localStop || (isQuietHours() ? "QUIET_HOURS" : null) || (shuttingDown ? "SHUTDOWN" : null) || (leaseStale() ? "LEASE_LOST" : null);
      if (local === "SHUTDOWN" || local === "LEASE_LOST") {
        // Left RUNNING on purpose: recovery (here after a restart, or in the
        // process that took the lease) carries on from the database.
        const why = local === "LEASE_LOST"
          ? ` — last lease renewal ${Math.round((Date.now() - lastRenewedAt) / 1000)}s ago`
          : "";
        console.log(`[Campaign ${campaignId}] send loop stopped (${local}${why}) — campaign stays RUNNING for recovery`);
        return;
      }
      if (local === "QUIET_HOURS") {
        await pauseForQuietHours(campaignId, numberId);
        return;
      }
      if (local === "NUMBER_INACTIVE") {
        await pauseFor("NUMBER_INACTIVE", localStopDetail);
        return;
      }
      if (local === "RATE_LIMIT" || local === "CONNECTION") {
        // Resumed by the scheduler at resumeAt; nobody was marked FAILED.
        await pauseFor(local, localStopDetail, new Date(Date.now() + AUTO_RESUME_MS[local]));
        return;
      }
      if (local === "SEND_ERROR") {
        await pauseFor("SEND_ERROR", localStopDetail || "Meta refused the send");
        return;
      }

      // Paused or cancelled by a person (here or in another instance): the
      // handler already wrote the status; nothing more to record.
      const row = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
      if (!row || row.status !== "RUNNING") {
        if (!row || row.status === "CANCELLED") campaignStopSignals.delete(campaignId);
        console.log(`[Campaign ${campaignId}] ${row ? row.status : "deleted"} — send loop stopped`);
        return;
      }
      observedStatus = "RUNNING";

      const left = await prisma.campaignRecipient.count({ where: { campaignId, status: "PENDING" } });
      if (left > 0) {
        // Next page, a retry later in the run, or resumed while draining.
        // Give a pause whose status write is still in flight a moment.
        if (campaignStopSignals.has(campaignId)) await sleep(250);
        continue;
      }

      // Anything still SENDING is ours and its outcome couldn't be recorded.
      // A claim that never reached Meta goes back to PENDING — send it.
      await settleInterruptedSends(campaignId);
      if (await prisma.campaignRecipient.count({ where: { campaignId, status: "PENDING" } })) continue;
      // Counts first, so a campaign is never seen COMPLETED with numbers that
      // don't add up. Only mark COMPLETED if still RUNNING — a cancel/pause
      // that landed after the last recipient's check must not be overwritten.
      await recountCampaign(campaignId, numberId).catch(() => {});
      progressDirty = false;
      const finished = await prisma.campaign.updateMany({
        where: { id: campaignId, status: "RUNNING" },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      if (finished.count > 0) emitToNumber(numberId, "campaign.completed", { campaignId });
      return;
    }
    console.error(`[Campaign ${campaignId}] gave up after too many passes — left RUNNING for recovery`);
  } finally {
    clearInterval(heartbeat);
    clearInterval(renewal);
    if (progressDirty) await recountCampaign(campaignId, numberId).catch(() => {});
  }
}

// SIGTERM: stop picking up recipients and wait (up to `timeoutMs`) for the
// in-flight sends to be written down. Campaigns stay RUNNING; the next process
// carries on from the database.
async function beginShutdown(timeoutMs = 25_000) {
  shuttingDown = true;
  const until = Date.now() + timeoutMs;
  while (runningCampaigns.size > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return runningCampaigns.size === 0;
}

// Whether this user may authorize sends — approve, reject, send, schedule.
// Asked of the permission table rather than of the role name, so a role that
// gains or loses campaign:send changes behaviour here with no code edit.
const canAuthorizeSend = (user) => roleHasPermission(user.role, "campaign:send");

const VALID_CATEGORIES = Object.values(CampaignCategory);

// "9:00 AM" in the quiet-hours timezone — for messages that say when a
// deferred send will actually start.
const formatWindowOpen = (date) =>
  date.toLocaleTimeString("en-US", { timeZone: getQuietHoursConfig().timezone, hour: "numeric", minute: "2-digit" });

// A scheduled time inside quiet hours is an explicit choice, so it is refused
// rather than silently moved.
const quietHoursScheduleError = (scheduledAt) => {
  if (!scheduledAt) return null;
  const at = new Date(scheduledAt);
  if (!isQuietHours(at)) return null;
  const { start, end } = getQuietHoursConfig();
  return new AppError(
    `That time is inside quiet hours (${start}–${end}). The earliest allowed time is ${formatWindowOpen(nextSendWindowOpen(at))}.`,
    400,
    "QUIET_HOURS",
  );
};

// A scheduled time must be a real date in the future. An invalid string used
// to reach the quiet-hours check and come back as a 500; a past one fired on
// the next scheduler tick without anyone choosing "send now".
const scheduleError = (scheduledAt) => {
  if (scheduledAt === undefined || scheduledAt === null || scheduledAt === "") return null;
  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return new AppError("scheduledAt isn't a valid date", 400, "INVALID_SCHEDULE");
  if (at.getTime() < Date.now() - 60_000) {
    return new AppError("That time is in the past. Pick a future time, or use Send now.", 400, "SCHEDULE_IN_PAST");
  }
  return quietHoursScheduleError(scheduledAt);
};

// Meta's daily limit on how many different people this number may message.
// Over it, the send is refused unless the person confirms (confirmOverLimit):
// past the limit Meta rejects the rest, and the campaign pauses until the
// 24-hour window frees up room.
async function capacityError(campaignId, confirmed) {
  if (confirmed === true) return null;
  const capacity = await getCampaignCapacity(campaignId).catch(() => null);
  if (!capacity || !capacity.overLimit) return null;
  return new AppError(
    `This campaign needs ${capacity.needed} people, but the number can only reach ${capacity.remaining} more today (limit ${capacity.limit} per 24 hours, ${capacity.usedLast24h} used). Messages past the limit will fail.`,
    409,
    "OVER_MESSAGING_LIMIT",
    capacity,
  );
}

// What a send/approve/resume response adds when quiet hours will hold it back.
const deferNote = () =>
  isQuietHours() ? ` — quiet hours, sending starts at ${formatWindowOpen(nextSendWindowOpen())}` : "";
const invalidCategory = (category) =>
  category !== undefined && !VALID_CATEGORIES.includes(category)
    ? new AppError(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(", ")}`, 400)
    : null;

// Someone who can write campaigns but not authorize them (today: AGENT) may
// only shape a campaign while it is still a DRAFT they created. From
// PENDING_APPROVAL onward it is frozen to them: approving is the send
// authorization, so the recipient list must not change after a reviewer has
// looked at it.
const assertAgentMayEdit = (campaign, user) => {
  if (canAuthorizeSend(user)) return null;
  if (campaign.status !== "DRAFT") {
    return new AppError(
      "This campaign has been submitted for approval and can no longer be edited. Ask an admin or the marketing team to reject it back to draft first.",
      403
    );
  }
  if (campaign.createdById !== user.id) {
    return new AppError("You can only edit campaigns you created", 403);
  }
  return null;
};

// ── Handlers ────────────────────────────────────────────────────────────────

const getCampaigns = async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { whatsappNumberId: req.numberId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        template: { select: { id: true, name: true, category: true } },
        submittedBy: { select: { id: true, name: true, username: true } },
        reviewedBy: { select: { id: true, name: true, username: true } },
        _count: { select: { recipients: true } },
      },
    });

    if (campaigns.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const campaignIds = campaigns.map((c) => c.id);

    // Single query for delivered + read counts across all campaigns
    const deliveredRaw = await prisma.$queryRaw`
      SELECT cr."campaignId",
        COUNT(CASE WHEN m.status IN ('DELIVERED', 'READ') THEN 1 END)::int AS delivered,
        COUNT(CASE WHEN m.status = 'READ' THEN 1 END)::int AS read_count
      FROM "CampaignRecipient" cr
      JOIN "Message" m ON m.id = cr."messageId"
      WHERE cr."campaignId" IN (${Prisma.join(campaignIds)})
      GROUP BY cr."campaignId"
    `;

    // Replied = recipients whose reply was linked to this campaign by the
    // webhook (CampaignRecipient.repliedAt; see utils/campaignAttribution.js).
    // This replaced a guess from conversation state, which stopped counting a
    // patient the moment an agent answered them, and counted anyone who wrote in
    // for an unrelated reason after the campaign started.
    const repliedRaw = await prisma.campaignRecipient.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: campaignIds }, repliedAt: { not: null } },
      _count: { _all: true },
    }).then((rows) => rows.map((r) => ({ campaignId: r.campaignId, replied: r._count._all })));

    // Appointments booked from this campaign's booking requests.
    const bookedRaw = await prisma.booking.groupBy({
      by: ["campaignId"],
      where: { campaignId: { in: campaignIds }, status: "BOOKED" },
      _count: { _all: true },
    });
    const bookedMap = new Map(bookedRaw.map((r) => [r.campaignId, r._count._all]));

    const deliveredMap = {};
    deliveredRaw.forEach((r) => { deliveredMap[r.campaignId] = r; });

    const repliedMap = {};
    repliedRaw.forEach((r) => { repliedMap[r.campaignId] = Number(r.replied); });

    const enriched = campaigns.map((c) => ({
      ...c,
      deliveredCount: Number(deliveredMap[c.id]?.delivered || 0),
      readCount: Number(deliveredMap[c.id]?.read_count || 0),
      repliedCount: repliedMap[c.id] || 0,
      bookedCount: bookedMap.get(c.id) || 0,
    }));

    res.status(200).json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
};

// Lightweight poll target for the campaigns list's "any campaign running"
// fallback — unlike getCampaigns, this never touches completed/cancelled
// history or the delivered/read/replied joins, so its cost stays flat no
// matter how much campaign history accumulates.
const getActiveCampaignProgress = async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { status: { in: ["RUNNING", "PAUSED"] }, whatsappNumberId: req.numberId },
      select: { id: true, status: true, sentCount: true, failedCount: true, totalRecipients: true },
    });
    res.status(200).json({ success: true, data: campaigns });
  } catch (err) {
    next(err);
  }
};

// ── The Replies worklist: who answered this campaign, and has anyone got back to them?
// One row per recipient who replied (CampaignRecipient.repliedAt), with their
// first reply and the current state of the conversation it arrived in.
// "Needs response" = the patient spoke last and the chat isn't resolved — the
// list's whole purpose is to show what is still waiting.
const getCampaignReplies = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

    const campaign = await prisma.campaign.findFirst({
      where: { id, whatsappNumberId: req.numberId },
      select: { id: true, whatsappNumberId: true },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));

    const where = { campaignId: id, repliedAt: { not: null } };
    const [recipients, total] = await Promise.all([
      prisma.campaignRecipient.findMany({
        where,
        orderBy: { repliedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          repliedAt: true,
          customer: { select: { id: true, name: true, phone: true } },
          replies: {
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { id: true, content: true, messageType: true, createdAt: true },
          },
        },
      }),
      prisma.campaignRecipient.count({ where }),
    ]);

    // The conversation each reply sits in: this customer, on the campaign's number.
    const conversations = await prisma.conversation.findMany({
      where: {
        whatsappNumberId: campaign.whatsappNumberId,
        customerId: { in: recipients.map((r) => r.customer.id) },
      },
      select: {
        id: true,
        customerId: true,
        status: true,
        lastSenderType: true,
        assignedAgent: { select: { id: true, name: true, username: true } },
      },
    });
    const byCustomer = new Map(conversations.map((c) => [c.customerId, c]));

    const data = recipients.map((r) => {
      const conv = byCustomer.get(r.customer.id) || null;
      return {
        recipientId: r.id,
        repliedAt: r.repliedAt,
        customer: r.customer,
        reply: r.replies[0] || null,
        conversation: conv && {
          id: conv.id,
          status: conv.status,
          assignedAgent: conv.assignedAgent,
        },
        needsResponse: Boolean(conv && conv.lastSenderType === "CUSTOMER" && conv.status !== "RESOLVED"),
      };
    });

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

const getCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findFirst({
      where: { id, whatsappNumberId: req.numberId, deletedAt: null },
      include: {
        template: true,
        segment: { select: { id: true, name: true, description: true } },
        flow: { select: { id: true, name: true, isActive: true } },
        // The approval trail shown on the detail page.
        submittedBy: { select: { id: true, name: true, username: true } },
        reviewedBy: { select: { id: true, name: true, username: true } },
        recipients: {
          include: { customer: { select: { id: true, name: true, phone: true, tags: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));

    // The same three figures getCampaigns computes for the list. The detail page
    // shows them as stat cards, and they read 0 while only the list set them.
    const [delivered, read, repliedCount, bookedCount, bookingRequestsCount] = await Promise.all([
      prisma.campaignRecipient.count({ where: { campaignId: id, message: { status: { in: ["DELIVERED", "READ"] } } } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, message: { status: "READ" } } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, repliedAt: { not: null } } }),
      prisma.booking.count({ where: { campaignId: id, status: "BOOKED" } }),
      prisma.bookingRequest.count({ where: { campaignId: id } }),
    ]);

    res.status(200).json({
      success: true,
      data: { ...campaign, deliveredCount: delivered, readCount: read, repliedCount, bookedCount, bookingRequestsCount },
    });
  } catch (err) {
    next(err);
  }
};

// Turn whatever the request asked for into a concrete, frozen recipient id list.
//
// A segment is a live rule, but a campaign's audience must not be. Resolving
// here — once, at the moment the campaign is written — is what makes the count
// an approver signs off on the same count that gets messaged, even if someone
// edits the segment an hour later. Consent exclusion is forced on regardless of
// the segment's own setting: this is a send path.
async function resolveAudience({ segmentId, recipientIds, whatsappNumberId = null }) {
  if (segmentId) {
    const segment = await prisma.segment.findUnique({ where: { id: parseInt(segmentId) } });
    if (!segment) throw new AppError("Segment not found", 404);

    const ids = await resolveMemberIds(segment.definition, {
      excludeOptedOut: true,
      whatsappNumberId,
    });
    return {
      ids,
      segmentId: segment.id,
      snapshot: {
        source: "SEGMENT",
        segmentId: segment.id,
        segmentName: segment.name,
        definition: segment.definition,
        resolvedAt: new Date().toISOString(),
        resolvedCount: ids.length,
      },
    };
  }

  const ids = [
    ...new Set((Array.isArray(recipientIds) ? recipientIds : []).map((n) => parseInt(n)).filter(Number.isInteger)),
  ];
  return {
    ids,
    segmentId: null,
    snapshot: {
      source: "MANUAL",
      resolvedAt: new Date().toISOString(),
      resolvedCount: ids.length,
    },
  };
}

// The flow (automation) answering this campaign's buttons. undefined = not
// given, null = none. Throws AppError on an unknown flow.
async function resolveFlowId(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const id = parseInt(raw);
  const flow = Number.isInteger(id) ? await prisma.flow.findUnique({ where: { id }, select: { id: true } }) : null;
  if (!flow) throw new AppError("Flow not found", 404);
  return flow.id;
}

const createCampaign = async (req, res, next) => {
  try {
    const { name, templateId, recipientIds, segmentId, scheduledAt, category } = req.body;
    if (!name) return next(new AppError("name is required", 400));
    const flowId = await resolveFlowId(req.body.flowId);
    if (!templateId) return next(new AppError("templateId is required", 400));
    const categoryErr = invalidCategory(category);
    if (categoryErr) return next(categoryErr);
    const schedErr = scheduleError(scheduledAt);
    if (schedErr) return next(schedErr);

    const template = await prisma.template.findUnique({ where: { id: parseInt(templateId) } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));
    if (template.approvalStatus !== "APPROVED") return next(new AppError("Template must be APPROVED before creating a campaign", 400));
    // Earliest possible feedback on a WABA mismatch — far better than a confusing
    // "template name unknown" from Meta at send time.
    numbers.assertTemplateUsable(template, req.number);

    // The audience is resolved against the SAME number the campaign will send
    // from, and that id is persisted below. If the two disagreed, the frozen
    // audience snapshot would describe a different population than the one
    // actually messaged.
    const audience = await resolveAudience({ segmentId, recipientIds, whatsappNumberId: req.numberId });
    const ids = audience.ids;

    // Only enforce recipients when actually sending/scheduling
    if (scheduledAt && ids.length === 0) {
      return next(
        new AppError(
          segmentId
            ? "That segment currently matches no reachable contacts — a campaign can't be scheduled against an empty audience"
            : "recipientIds are required when scheduling a campaign",
          400,
        ),
      );
    }

    // Anyone may propose a send time, but only someone who can authorize sends
    // can put a campaign into a state the scheduler will actually fire. So an
    // agent's campaign always starts as a DRAFT, scheduledAt and all.
    const status = canAuthorizeSend(req.user) && scheduledAt ? "SCHEDULED" : "DRAFT";

    const campaign = await prisma.campaign.create({
      data: {
        name,
        templateId: parseInt(templateId),
        flowId: flowId ?? null,
        category: category || "OTHER",
        whatsappNumberId: req.numberId,
        status,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        totalRecipients: ids.length,
        segmentId: audience.segmentId,
        audienceSnapshot: audience.snapshot,
        createdById: req.user.id,
        recipients: {
          create: ids.map((cid) => ({ customerId: cid })),
        },
      },
      include: {
        template: { select: { id: true, name: true, category: true } },
        segment: { select: { id: true, name: true } },
        flow: { select: { id: true, name: true, isActive: true } },
      },
    });

    logAudit({
      action: "CAMPAIGN_CREATED",
      actor: req.user,
      targetType: "Campaign",
      targetId: campaign.id,
      details: {
        name: campaign.name,
        status,
        category: campaign.category,
        templateId: campaign.templateId,
        templateName: template.name,
        recipientCount: ids.length,
        audienceSource: audience.snapshot.source,
        segmentId: audience.segmentId,
        segmentName: audience.snapshot.segmentName || null,
        scheduledAt: scheduledAt || null,
      },
    });

    res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    next(err);
  }
};

// Re-run a DRAFT campaign's segment against the current data.
//
// Deliberately restricted to DRAFT. From PENDING_APPROVAL onward the audience
// is what was reviewed, and re-resolving it would let the recipient list move
// after sign-off — the exact hole the approval trail exists to close.
const refreshCampaignAudience = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    if (existing.status !== "DRAFT") {
      return next(new AppError("Only a DRAFT campaign's audience can be refreshed", 400));
    }
    if (!existing.segmentId) {
      return next(new AppError("This campaign has a manually picked audience, so there is no segment to re-run", 400));
    }
    const editErr = assertAgentMayEdit(existing, req.user);
    if (editErr) return next(editErr);

    const previous = existing.totalRecipients;
    // Resolved against the campaign's own line, exactly as at creation: per-line
    // opt-outs and "on this number" rules must give the same people.
    const audience = await resolveAudience({ segmentId: existing.segmentId, whatsappNumberId: existing.whatsappNumberId });

    const [, campaign] = await prisma.$transaction([
      prisma.campaignRecipient.deleteMany({ where: { campaignId: id } }),
      prisma.campaign.update({
        where: { id },
        data: {
          totalRecipients: audience.ids.length,
          audienceSnapshot: audience.snapshot,
          recipients: { create: audience.ids.map((cid) => ({ customerId: cid })) },
        },
        include: {
          template: { select: { id: true, name: true, category: true } },
          segment: { select: { id: true, name: true } },
        },
      }),
    ]);

    logAudit({
      action: "CAMPAIGN_AUDIENCE_REFRESHED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: {
        name: campaign.name,
        segmentId: existing.segmentId,
        previousCount: previous,
        newCount: audience.ids.length,
      },
    });

    res.status(200).json({
      success: true,
      data: campaign,
      meta: { previousCount: previous, newCount: audience.ids.length, delta: audience.ids.length - previous },
    });
  } catch (err) {
    next(err);
  }
};

const updateCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    if (existing.status !== "DRAFT") return next(new AppError("Only DRAFT campaigns can be updated", 400));
    const editErr = assertAgentMayEdit(existing, req.user);
    if (editErr) return next(editErr);

    const { name, templateId, recipientIds, segmentId, scheduledAt, category } = req.body;
    const flowId = await resolveFlowId(req.body.flowId);
    const categoryErr = invalidCategory(category);
    if (categoryErr) return next(categoryErr);
    const schedErr = scheduleError(scheduledAt);
    if (schedErr) return next(schedErr);

    // A new template gets the same checks as at creation: approved, active,
    // and on this number's business account.
    if (templateId && parseInt(templateId) !== existing.templateId) {
      const template = await prisma.template.findUnique({ where: { id: parseInt(templateId) } });
      if (!template || !template.isActive) return next(new AppError("Template not found", 404));
      if (template.approvalStatus !== "APPROVED") return next(new AppError("Template must be APPROVED before it can be used in a campaign", 400));
      numbers.assertTemplateUsable(template, req.number);
    }

    const data = {};
    if (name) data.name = name;
    if (category) data.category = category;
    if (templateId) data.templateId = parseInt(templateId);
    if (flowId !== undefined) data.flowId = flowId;
    if (scheduledAt !== undefined) data.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    // Same rule as create: only an edit by someone who can authorize sends may
    // arm the scheduler.
    if (scheduledAt && canAuthorizeSend(req.user)) data.status = "SCHEDULED";

    // Switching a draft to a segment re-resolves and re-freezes it; switching
    // back to a hand-picked list clears the segment link so the snapshot can't
    // claim a provenance the recipients no longer have.
    const rebuild = segmentId !== undefined || (recipientIds && Array.isArray(recipientIds));
    if (rebuild) {
      // Same line as the campaign, like create and refresh.
      const audience = await resolveAudience({ segmentId, recipientIds, whatsappNumberId: existing.whatsappNumberId });
      data.totalRecipients = audience.ids.length;
      data.segmentId = audience.segmentId;
      data.audienceSnapshot = audience.snapshot;
      data.recipients = { create: audience.ids.map((cid) => ({ customerId: cid })) };
    }

    // Delete-and-recreate in one transaction: a failed update can't leave the
    // campaign with no recipients but its old count, and two saves at once
    // can't both insert (the unique campaign+customer rule fails the second).
    const include = {
      template: { select: { id: true, name: true, category: true } },
      segment: { select: { id: true, name: true } },
      flow: { select: { id: true, name: true, isActive: true } },
    };
    const campaign = rebuild
      ? (await prisma.$transaction([
          prisma.campaignRecipient.deleteMany({ where: { campaignId: id } }),
          prisma.campaign.update({ where: { id }, data, include }),
        ]))[1]
      : await prisma.campaign.update({ where: { id }, data, include });

    logAudit({
      action: "CAMPAIGN_UPDATED",
      actor: req.user,
      targetType: "Campaign",
      targetId: campaign.id,
      details: {
        name: campaign.name,
        category: campaign.category,
        recipientCount: campaign.totalRecipients,
        scheduledAt: campaign.scheduledAt || null,
      },
    });

    res.status(200).json({ success: true, data: campaign });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/campaigns/:id/flow { flowId | null } ──────────────────────────
// Attach or detach the automation at any stage — unlike the rest of a campaign,
// which freezes after DRAFT. Safe mid-send: the flow only acts on replies, and
// runs already in progress keep the flow they started with.
const setCampaignFlow = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    const editErr = existing.status === "DRAFT" ? assertAgentMayEdit(existing, req.user) : null;
    if (editErr) return next(editErr);
    const flowId = await resolveFlowId(req.body.flowId === undefined ? null : req.body.flowId);

    const campaign = await prisma.campaign.update({
      where: { id },
      data: { flowId },
      include: { flow: { select: { id: true, name: true, isActive: true } } },
    });
    logAudit({
      action: "CAMPAIGN_FLOW_SET",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: { name: campaign.name, flowId, previousFlowId: existing.flowId },
    });
    res.status(200).json({ success: true, data: campaign });
  } catch (err) {
    next(err);
  }
};

// Deletable terminal/idle states. RUNNING/PAUSED/SCHEDULED are intentionally
// excluded — an in-flight or pending send must be cancelled first, so deletion
// can never silently abandon a send mid-flight. CampaignRecipient rows are
// removed automatically (onDelete: Cascade in the schema).
const DELETABLE_STATUSES = ["DRAFT", "COMPLETED", "CANCELLED"];

// A campaign that went out is hidden, not erased: its recipients, sends and
// reply links are the history ("did we message her in March?") and the
// reporting. One that never went out (a draft) is really deleted.
async function removeCampaigns(campaigns) {
  const sent = campaigns.filter((c) => c.status !== "DRAFT" && c.sentCount + c.failedCount > 0).map((c) => c.id);
  const erase = campaigns.filter((c) => !sent.includes(c.id)).map((c) => c.id);
  const [hidden, erased] = await prisma.$transaction([
    prisma.campaign.updateMany({ where: { id: { in: sent }, deletedAt: null }, data: { deletedAt: new Date() } }),
    prisma.campaign.deleteMany({ where: { id: { in: erase } } }),
  ]);
  return hidden.count + erased.count;
}

const deleteCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId, deletedAt: null } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    if (!DELETABLE_STATUSES.includes(existing.status)) {
      return next(new AppError(`Can't delete a ${existing.status} campaign — cancel it first`, 400));
    }
    const delErr = assertAgentMayEdit(existing, req.user);
    if (delErr) return next(delErr);

    await removeCampaigns([existing]);

    logAudit({
      action: "CAMPAIGN_DELETED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: { name: existing.name, status: existing.status, recipientCount: existing.totalRecipients },
    });

    res.status(200).json({ success: true, message: "Campaign deleted" });
  } catch (err) {
    next(err);
  }
};

// Bulk delete — one round-trip for many campaigns. Skips any that are
// missing or in a non-deletable state and reports how many were actually
// removed, so a partial selection never fails wholesale.
const bulkDeleteCampaigns = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return next(new AppError("ids must be a non-empty array", 400));
    }
    const parsedIds = ids.map((n) => parseInt(n)).filter((n) => Number.isInteger(n));
    if (parsedIds.length === 0) return next(new AppError("No valid campaign ids provided", 400));

    const candidates = await prisma.campaign.findMany({
      where: {
        id: { in: parsedIds },
        status: { in: DELETABLE_STATUSES },
        deletedAt: null,
        // Scoped so a list of ids cannot reach across into another line's
        // campaigns. Silently skipping them matches this handler's existing
        // partial-success contract.
        whatsappNumberId: req.numberId,
      },
    });
    // The same rule as deleting one: someone who can't authorize sends may
    // only delete their own drafts. Others in the selection are skipped.
    const allowed = candidates.filter((c) => !assertAgentMayEdit(c, req.user));
    const result = { count: await removeCampaigns(allowed) };

    logAudit({
      action: "CAMPAIGN_BULK_DELETED",
      actor: req.user,
      targetType: "Campaign",
      targetId: 0,
      details: { requestedIds: parsedIds, deletedCount: result.count },
    });

    res.status(200).json({
      success: true,
      deletedCount: result.count,
      skippedCount: parsedIds.length - result.count,
      message: `Deleted ${result.count} campaign${result.count !== 1 ? "s" : ""}`,
    });
  } catch (err) {
    next(err);
  }
};

const sendCampaignNow = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (campaign.status !== "DRAFT" && campaign.status !== "SCHEDULED") {
      return next(new AppError("Campaign cannot be sent in its current state", 400));
    }
    if (campaign.totalRecipients === 0) {
      return next(new AppError("Campaign has no recipients", 400));
    }
    await checkCampaignSendable(id);
    const overErr = await capacityError(id, req.body?.confirmOverLimit);
    if (overErr) return next(overErr);

    // Atomic status-guarded transition: the DRAFT/SCHEDULED condition lives in
    // the WHERE clause itself, so two concurrent requests (double-click,
    // double-submit, retried request) can never both flip this campaign to
    // RUNNING — only the first UPDATE's WHERE still matches, the second's
    // matches zero rows and count comes back 0.
    const { count } = await prisma.campaign.updateMany({
      where: { id, status: { in: ["DRAFT", "SCHEDULED"] } },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    if (count === 0) {
      return next(new AppError("Campaign is already sending", 409));
    }

    logAudit({
      action: "CAMPAIGN_SENT",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: {
        name: campaign.name,
        templateId: campaign.templateId,
        recipientCount: campaign.totalRecipients,
        previousStatus: campaign.status,
      },
    });

    // Fire-and-forget
    processCampaign(id).catch((err) => console.error(`[Campaign ${id}] Fatal error:`, err.message));

    res.status(200).json({ success: true, message: `Campaign send started${deferNote()}` });
  } catch (err) {
    next(err);
  }
};

const cancelCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (!["SCHEDULED", "RUNNING", "PAUSED"].includes(campaign.status)) {
      return next(new AppError("Only SCHEDULED, RUNNING, or PAUSED campaigns can be cancelled", 400));
    }

    // The signal stops a loop running in this process at once; one running in
    // another instance sees CANCELLED on its next heartbeat. Status-guarded so
    // a campaign that completed meanwhile is not rewritten as cancelled.
    if (runningCampaigns.has(id)) campaignStopSignals.set(id, "CANCELLED");
    const { count: cancelled } = await prisma.campaign.updateMany({
      where: { id, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } },
      data: { status: "CANCELLED" },
    });
    if (cancelled === 0) {
      return next(new AppError("This campaign already finished and can't be cancelled", 409));
    }
    emitToNumber(campaign.whatsappNumberId, "campaign.cancelled", { campaignId: id });

    logAudit({
      action: "CAMPAIGN_CANCELLED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: { name: campaign.name, sentCount: campaign.sentCount, totalRecipients: campaign.totalRecipients },
    });

    res.status(200).json({ success: true, message: "Campaign cancelled" });
  } catch (err) {
    next(err);
  }
};

const pauseCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);

    // Atomic RUNNING → PAUSED transition, same reasoning as sendCampaignNow's
    // guarded update: avoids a race with e.g. the campaign completing between
    // the check and the write.
    // Loading the row first is what makes the audit details below valid: they
    // previously referenced an undeclared `campaign`, throwing a ReferenceError
    // that the catch swallowed AFTER the campaign had already flipped to PAUSED.
    const campaign = await prisma.campaign.findFirst({
      where: { id, whatsappNumberId: req.numberId },
      select: { id: true, name: true, sentCount: true, totalRecipients: true, whatsappNumberId: true },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));

    // Also takes over an automatic pause (quiet hours, rate limit, connection),
    // which would otherwise resume on its own: a person's pause always wins.
    if (runningCampaigns.has(id)) campaignStopSignals.set(id, "PAUSED");
    const { count } = await prisma.campaign.updateMany({
      where: {
        id,
        OR: [
          { status: "RUNNING" },
          { status: "PAUSED", pauseReason: { in: ["QUIET_HOURS", "RATE_LIMIT", "CONNECTION"] } },
        ],
      },
      data: { status: "PAUSED", pauseReason: "MANUAL", pauseDetail: null, resumeAt: null },
    });
    if (count === 0) {
      campaignStopSignals.delete(id);
      return next(new AppError("Only a sending (or automatically paused) campaign can be paused", 400));
    }
    emitToNumber(campaign.whatsappNumberId, "campaign.paused", { campaignId: id });

    logAudit({
      action: "CAMPAIGN_PAUSED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: { name: campaign.name, sentCount: campaign.sentCount, totalRecipients: campaign.totalRecipients },
    });

    res.status(200).json({ success: true, message: "Campaign paused" });
  } catch (err) {
    campaignStopSignals.delete(parseInt(req.params.id));
    next(err);
  }
};

const resumeCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);

    // Atomic PAUSED → RUNNING transition guards against double-resume the
    // same way sendCampaignNow guards against double-send.
    // Same as pauseCampaign: the audit details below referenced an undeclared
    // `campaign`, which threw on every resume.
    const campaign = await prisma.campaign.findFirst({
      where: { id, whatsappNumberId: req.numberId },
      select: { id: true, name: true, sentCount: true, totalRecipients: true, whatsappNumberId: true },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    // A template that was deleted or paused by Meta is why some campaigns
    // stopped; resuming must not just hit the same wall.
    await checkCampaignSendable(id);

    const { count } = await prisma.campaign.updateMany({
      where: { id, status: "PAUSED" },
      data: { status: "RUNNING", pauseReason: null, pauseDetail: null, resumeAt: null },
    });
    if (count === 0) {
      return next(new AppError("Only PAUSED campaigns can be resumed", 400));
    }
    campaignStopSignals.delete(id);

    // processCampaign only ever touches recipients still PENDING, so resuming
    // is inherently safe — identical to the scheduler's crash-recovery resume.
    processCampaign(id).catch((err) => console.error(`[Campaign ${id}] Fatal error:`, err.message));

    logAudit({
      action: "CAMPAIGN_RESUMED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: { name: campaign.name, sentCount: campaign.sentCount, totalRecipients: campaign.totalRecipients },
    });

    res.status(200).json({ success: true, message: `Campaign resumed${deferNote()}` });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/campaigns/pending-approval ─────────────────────────────────────
// Campaigns waiting for an admin, across ALL numbers (an admin reviewing one
// line must still see that another line has something waiting). For the
// sidebar badge and the "Awaiting approval" section.
const getPendingApprovals = async (req, res, next) => {
  try {
    const pending = await prisma.campaign.findMany({
      where: { status: "PENDING_APPROVAL", deletedAt: null },
      orderBy: { submittedAt: "asc" },
      select: {
        id: true,
        name: true,
        whatsappNumberId: true,
        whatsappNumber: { select: { label: true } },
        totalRecipients: true,
        scheduledAt: true,
        submittedAt: true,
        submittedBy: { select: { id: true, name: true, username: true } },
        template: { select: { id: true, name: true } },
      },
    });
    res.status(200).json({ success: true, data: pending, total: pending.length });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/campaigns/:id/capacity ────────────────────────────────────────
// How many people this campaign still needs vs. what the number's Meta
// messaging limit leaves for today. For the send / approve dialogs.
const getCampaignCapacityHandler = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId, deletedAt: null }, select: { id: true } });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    res.status(200).json({ success: true, data: await getCampaignCapacity(id) });
  } catch (err) {
    next(err);
  }
};

// The quiet-hours window, so the wizard can warn before a bad schedule is sent.
const getQuietHours = async (req, res, next) => {
  try {
    const { start, end, timezone, enabled } = getQuietHoursConfig();
    res.status(200).json({
      success: true,
      data: { start, end, timezone, enabled, isQuietNow: isQuietHours(), nextOpenAt: nextSendWindowOpen() },
    });
  } catch (err) {
    next(err);
  }
};

// ── Approval workflow ───────────────────────────────────────────────────────

// Agent (or admin) hands a finished draft over for review.
const submitCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findFirst({
      where: { id, whatsappNumberId: req.numberId },
      include: { template: true },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (campaign.status !== "DRAFT") {
      return next(new AppError("Only a DRAFT campaign can be submitted for approval", 400));
    }
    const ownErr = assertAgentMayEdit(campaign, req.user);
    if (ownErr) return next(ownErr);
    if (campaign.totalRecipients === 0) {
      return next(new AppError("Add at least one recipient before submitting for approval", 400));
    }
    // Re-checked here as well as at create time: updateCampaign can re-point a
    // DRAFT at a different template, Meta can pause one, and approval is the
    // send authorization.
    assertCampaignSendable({ template: campaign.template, number: req.number });

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        status: "PENDING_APPROVAL",
        submittedById: req.user.id,
        submittedAt: new Date(),
        // Clear any previous rejection so a resubmission starts clean.
        rejectionReason: null,
        reviewedById: null,
        reviewedAt: null,
      },
      include: { template: { select: { id: true, name: true, category: true } } },
    });

    logAudit({
      action: "CAMPAIGN_SUBMITTED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: {
        name: campaign.name,
        recipientCount: campaign.totalRecipients,
        templateName: campaign.template?.name,
      },
    });

    emitToNumber(campaign.whatsappNumberId, "campaign.submitted", { campaignId: id });
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// Admin authorizes the send. Approval IS the authorization — the campaign
// goes straight into the sending pipeline, using whatever send time the
// submitter proposed, so nothing can be altered between review and send.
const approveCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (campaign.status !== "PENDING_APPROVAL") {
      return next(new AppError("Only a campaign awaiting approval can be approved", 400));
    }
    if (campaign.totalRecipients === 0) {
      return next(new AppError("Campaign has no recipients", 400));
    }
    // Days can pass between submit and approve: the template may have been
    // deleted or paused by Meta since.
    await checkCampaignSendable(id);

    // A future scheduledAt hands the campaign to the cron scheduler; anything
    // else (absent, or already past) sends now.
    const sendNow = !campaign.scheduledAt || campaign.scheduledAt <= new Date();
    if (sendNow) {
      const overErr = await capacityError(id, req.body?.confirmOverLimit);
      if (overErr) return next(overErr);
    }

    // Status-guarded so two admins clicking Approve can't both start the send.
    const { count } = await prisma.campaign.updateMany({
      where: { id, status: "PENDING_APPROVAL" },
      data: {
        status: sendNow ? "RUNNING" : "SCHEDULED",
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        rejectionReason: null,
        ...(sendNow ? { startedAt: new Date() } : {}),
      },
    });
    if (count === 0) return next(new AppError("Campaign is no longer awaiting approval", 409));

    logAudit({
      action: "CAMPAIGN_APPROVED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: {
        name: campaign.name,
        recipientCount: campaign.totalRecipients,
        submittedById: campaign.submittedById,
        outcome: sendNow ? "sending now" : "scheduled",
        scheduledAt: campaign.scheduledAt || null,
      },
    });

    if (sendNow) {
      processCampaign(id).catch((err) =>
        console.error(`[Campaign ${id}] Fatal error:`, err.message)
      );
    }

    emitToNumber(campaign.whatsappNumberId, "campaign.approved", { campaignId: id });
    res.status(200).json({
      success: true,
      message: sendNow ? `Campaign approved — sending now${deferNote()}` : "Campaign approved and scheduled",
    });
  } catch (err) {
    next(err);
  }
};

// Admin sends it back with a reason. Returns to DRAFT so the submitter can fix
// and resubmit.
const rejectCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return next(new AppError("A reason is required so the submitter knows what to change", 400));
    }

    const campaign = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (campaign.status !== "PENDING_APPROVAL") {
      return next(new AppError("Only a campaign awaiting approval can be rejected", 400));
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        status: "DRAFT",
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        rejectionReason: String(reason).trim(),
      },
      include: { template: { select: { id: true, name: true, category: true } } },
    });

    logAudit({
      action: "CAMPAIGN_REJECTED",
      actor: req.user,
      targetType: "Campaign",
      targetId: id,
      details: {
        name: campaign.name,
        submittedById: campaign.submittedById,
        reason: String(reason).trim(),
      },
    });

    emitToNumber(campaign.whatsappNumberId, "campaign.rejected", { campaignId: id });
    res.status(200).json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Test send ───────────────────────────────────────────────────────────────

// Sends one template to a single number so an admin can see the real thing on
// a real handset before committing to a blast. Deliberately does NOT create a
// campaign, recipient rows or a stored message — a test must not show up in
// reporting or pollute a customer's chat history.
const testSendTemplate = async (req, res, next) => {
  try {
    const { templateId, phone } = req.body;

    if (!templateId) return next(new AppError("templateId is required", 400));
    if (!phone || typeof phone !== "string") {
      return next(new AppError("A phone number is required", 400));
    }

    // Same normalisation the CSV importer uses, so a number that works here
    // works in a campaign.
    const parsed = parsePhoneNumberFromString(phone.trim(), "AE");
    if (!parsed || !parsed.isValid()) {
      return next(
        new AppError(
          "That doesn't look like a valid phone number. Include the country code, e.g. +971 50 123 4567.",
          400
        )
      );
    }
    const to = parsed.number.replace("+", "");

    const template = await prisma.template.findUnique({
      where: { id: Number(templateId) },
    });
    if (!template) return next(new AppError("Template not found", 404));
    // A test send has no campaign row, so unlike every other send path the
    // number comes from the request. Guarded so a test cannot "prove" a template
    // works on a line it could never actually be sent from.
    numbers.assertTemplateUsable(template, req.number);
    const credentials = await numbers.getCredentials(req.numberId);

    // Personalise against the real contact when we have one — testing
    // {{first_name}} against a placeholder proves very little.
    const customer = await prisma.customer.findUnique({ where: { phone: to } });

    const optedOutHere = customer
      ? await prisma.customerOptOut.findUnique({
          where: {
            customerId_whatsappNumberId: { customerId: customer.id, whatsappNumberId: req.numberId },
          },
          select: { id: true },
        })
      : null;

    if (customer?.optedOut || optedOutHere) {
      return next(
        new AppError(
          optedOutHere && !customer.optedOut
            ? `That contact has opted out of messages from "${req.number.label}", so no test can be sent to them on this number.`
            : "That contact has opted out of marketing messages, so no test can be sent to them. Use a different number.",
          409
        )
      );
    }

    const sample = customer ?? { name: req.user.name || "Test Contact" };
    const { sendArgs, needsMetaTemplate, resolvedBody } = buildTemplateSend(
      template,
      sample,
      req.user
    );

    let whatsappMessageId;
    try {
      ({ whatsappMessageId } = await sendWhatsAppMessage({ number: credentials, to, ...sendArgs }));
    } catch (waErr) {
      const metaMsg =
        waErr.response?.data?.error?.message || waErr.message || "Unknown error";
      console.error("[TestSend] WhatsApp send failed:", waErr.response?.data || waErr.message);
      // The most common cause by far: an unapproved template can only go out
      // as an ad-hoc message, which Meta rejects outside an open 24h window.
      const hint = needsMetaTemplate
        ? ""
        : " This template isn't approved by Meta yet, so it can only reach a number that has messaged you in the last 24 hours. Submit it for approval to test on any number.";
      return next(new AppError("WhatsApp rejected the test send: " + metaMsg + hint, 502));
    }

    logAudit({
      action: "TEMPLATE_TEST_SEND",
      actor: req.user,
      targetType: "Template",
      targetId: template.id,
      details: {
        to,
        templateName: template.name,
        asMetaTemplate: needsMetaTemplate,
        // Recorded so the audit trail says which line the test actually went out on.
        whatsappNumberId: req.numberId,
        whatsappNumberLabel: req.number.label,
      },
    });

    res.status(200).json({
      success: true,
      data: {
        to,
        whatsappMessageId,
        personalizedFor: customer?.name || null,
        asMetaTemplate: needsMetaTemplate,
        preview: resolvedBody,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getPendingApprovals,
  beginShutdown,
  getCampaignCapacity: getCampaignCapacityHandler,
  recountCampaign,
  setCampaignFlow,
  getCampaignReplies,
  getCampaigns,
  getActiveCampaignProgress,
  getQuietHours,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  bulkDeleteCampaigns,
  sendCampaignNow,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  submitCampaign,
  approveCampaign,
  rejectCampaign,
  testSendTemplate,
  processCampaign,
  refreshCampaignAudience,
};
