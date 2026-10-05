const { Prisma, CampaignCategory } = require("@prisma/client");
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

// Campaign IDs stopped (cancelled or paused) while a send is in-flight,
// checked in-memory instead of via a DB round-trip per recipient. Maps to
// "CANCELLED" or "PAUSED" so the loop knows which terminal state to leave the
// campaign in once in-flight recipients drain. Single-instance only (matches
// the scheduler's existing single-instance assumption) — fine since both
// pause and cancel are always initiated by an HTTP request handled by this
// same process.
const campaignStopSignals = new Map();

// Campaigns with a send loop running in this process. processCampaign refuses
// to start a second loop for the same campaign: after a quick Pause → Resume
// the first loop is still draining, and a second one would load the same
// PENDING recipients and message them twice. The running loop simply carries
// on once the stop signal is cleared.
const runningCampaigns = new Set();
// The Meta error that paused a campaign, for its pauseDetail.
const systemicErrors = new Map();

// Meta errors that are about the account, token or template — not about one
// recipient. Hitting one means every other send will fail the same way, so the
// campaign is paused (SEND_ERROR) instead of marking the whole audience FAILED.
const SYSTEMIC_META_CODES = new Set([
  0, 3, 10, 190, 200, // auth / permission / token
  100, // invalid parameter (bad payload for every recipient)
  368, 131031, // account restricted / locked
  131042, // payment problem
  131048, 131056, 130429, 80007, // rate / spam limits
  131008, 131009, 132000, 132001, 132005, 132007, 132012, 132015, 132016, // template
]);
const metaErrorOf = (err) => err?.response?.data?.error || null;

async function runWithConcurrency(items, limit, getStopSignal, worker) {
  let idx = 0;
  async function lane() {
    while (idx < items.length) {
      if (getStopSignal()) return;
      const item = items[idx++];
      await worker(item);
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

// ── Exported for scheduler ──────────────────────────────────────────────────

async function processCampaign(campaignId) {
  if (runningCampaigns.has(campaignId)) {
    console.log(`[Campaign ${campaignId}] send loop already running — not starting a second one`);
    return;
  }
  runningCampaigns.add(campaignId);
  try {
    await runCampaign(campaignId);
  } finally {
    runningCampaigns.delete(campaignId);
  }
}

async function runCampaign(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      template: true,
      whatsappNumber: true,
      recipients: {
        where: { status: "PENDING" },
        include: { customer: true },
      },
    },
  });
  if (!campaign) return;

  const numberId = campaign.whatsappNumberId;

  // Quiet hours. Every send path ends up here (send-now, approve, resume, the
  // cron and crash recovery), so this is the one place the rule is enforced.
  // The campaign is parked as PAUSED/QUIET_HOURS and the scheduler resumes it
  // when the window opens.
  if (isQuietHours()) {
    await pauseForQuietHours(campaignId, numberId);
    return;
  }

  // The number is read from the campaign row, never from a request: three of the
  // four entry points into this function (resume, approve, and the cron in
  // jobs/campaignScheduler.js) have no HTTP request to read a header from.
  //
  // A deactivated number pauses the campaign rather than letting every recipient
  // fall through to the catch below and be burned as FAILED. Deactivation is an
  // operator action, not N delivery failures — and FAILED recipients are not
  // retried on resume, so that would be unrecoverable.
  let credentials;
  try {
    if (!campaign.whatsappNumber || !campaign.whatsappNumber.isActive) {
      throw new AppError(
        `WhatsApp number for this campaign is unavailable or deactivated`,
        409,
        "NUMBER_INACTIVE",
      );
    }
    // Last line of defence: every send path funnels through here, so a template
    // that does not belong to this number's WABA is caught before anything is
    // sent, even if it slipped past the checks at create/update/submit time.
    numbers.assertTemplateUsable(campaign.template, campaign.whatsappNumber);
    // A campaign must go out as an approved Meta template. Anything else would
    // fall back to a plain message, which Meta only accepts inside a 24-hour
    // window — i.e. it would fail for almost everyone.
    if (!buildTemplateSend(campaign.template, { name: "" }).needsMetaTemplate) {
      throw new AppError(`Template "${campaign.template.name}" isn't an approved Meta template`, 409, "TEMPLATE_NOT_APPROVED");
    }
    credentials = await numbers.getCredentials(campaign.whatsappNumber);
  } catch (err) {
    console.error(`[Campaign ${campaignId}] cannot start:`, err.message);
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: "RUNNING" },
      data: {
        status: "PAUSED",
        pauseReason: err.errorCode === "NUMBER_INACTIVE" ? "NUMBER_INACTIVE" : "SEND_ERROR",
        pauseDetail: err.message,
      },
    });
    emitToNumber(numberId, "campaign.paused", { campaignId, reason: err.message });
    return;
  }

  const laneLimit = campaign.whatsappNumber.sendConcurrency || CAMPAIGN_SEND_CONCURRENCY;

  campaignStopSignals.delete(campaignId);
  emitToNumber(numberId, "campaign.started", { campaignId });

  // Quiet hours starting mid-send stops the lanes the same way a pause does:
  // no new recipient is picked up, in-flight sends finish.
  const getStopSignal = () =>
    campaignStopSignals.get(campaignId) || (isQuietHours() ? "QUIET_HOURS" : undefined);

  await runWithConcurrency(campaign.recipients, laneLimit, getStopSignal, async (recipient) => {
    await acquireLane(numberId, laneLimit);
    try {
      // Two consent checks, deliberately. optedOut is a global do-not-contact
      // switch; a CustomerOptOut row is a STOP sent to THIS line specifically.
      // Either one suppresses the send.
      const optedOutHere = await prisma.customerOptOut.findUnique({
        where: {
          customerId_whatsappNumberId: { customerId: recipient.customerId, whatsappNumberId: numberId },
        },
        select: { id: true },
      });
      if (recipient.customer.optedOut || optedOutHere) {
        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "SKIPPED" },
        });
        return;
      }

      // Get or create the conversation for THIS number. Upsert rather than
      // find-then-create: two campaigns on different numbers targeting the same
      // customer make that race genuinely reachable.
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
      if (!existed) {
        emitToNumber(numberId, "conversation.created", { conversationId: conversation.id });
      }

      const template = campaign.template;
      const customer = recipient.customer;

      // Shared with the test-send endpoint so a test proves something about
      // the real send. See utils/templateSend.js.
      const { resolvedBody, templateContent, sendArgs } = buildTemplateSend(
        template,
        customer,
        null
      );

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
        },
      });

      try {
        const { whatsappMessageId } = await sendWhatsAppMessage({
          number: credentials,
          to: customer.phone,
          ...sendArgs,
        });
        message = await prisma.message.update({
          where: { id: message.id },
          data: { whatsappMessageId, status: "SENT" },
        });
      } catch (waErr) {
        console.error(`[Campaign ${campaignId}] WhatsApp send failed for customer ${customer.id}:`, waErr.response?.data || waErr.message);
        const metaErr = metaErrorOf(waErr);
        if (metaErr && SYSTEMIC_META_CODES.has(Number(metaErr.code))) {
          // Stop the campaign rather than fail everyone the same way. This
          // recipient was never sent to: drop the placeholder message and leave
          // them PENDING so Resume retries them.
          await prisma.message.delete({ where: { id: message.id } }).catch(() => {});
          if (!campaignStopSignals.has(campaignId)) {
            campaignStopSignals.set(campaignId, "SEND_ERROR");
            systemicErrors.set(campaignId, `Meta error ${metaErr.code}: ${metaErr.error_user_msg || metaErr.message}`);
          }
          return;
        }
        await prisma.message.update({
          where: { id: message.id },
          data: {
            status: "FAILED",
            errorCode: metaErr ? Number(metaErr.code) || null : null,
            errorTitle: metaErr ? metaErr.error_user_title || metaErr.message || null : null,
          },
        });
        throw waErr;
      }

      // Batched into one round-trip instead of three sequential ones.
      const [, , updatedCampaign] = await prisma.$transaction([
        prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessage: resolvedBody, lastMessageAt: new Date(), lastSenderType: "AGENT" },
        }),
        prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "SENT", messageId: message.id, sentAt: new Date() },
        }),
        prisma.campaign.update({
          where: { id: campaignId },
          data: { sentCount: { increment: 1 } },
          select: { sentCount: true, failedCount: true, totalRecipients: true },
        }),
      ]);

      emitToNumber(numberId, "message.created", { message, conversationId: conversation.id });
      emitToNumber(numberId, "conversation.updated", { conversationId: conversation.id });
      emitToNumber(numberId, "campaign.progress", { campaignId, ...updatedCampaign });
    } catch (err) {
      const [, updatedCampaign] = await prisma.$transaction([
        prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "FAILED", error: err.message },
        }),
        prisma.campaign.update({
          where: { id: campaignId },
          data: { failedCount: { increment: 1 } },
          select: { sentCount: true, failedCount: true, totalRecipients: true },
        }),
      ]);
      emitToNumber(numberId, "campaign.progress", { campaignId, ...updatedCampaign });
    } finally {
      releaseLane(numberId);
    }
  });

  const stopSignal = getStopSignal();
  campaignStopSignals.delete(campaignId);

  if (stopSignal === "CANCELLED") {
    console.log(`[Campaign ${campaignId}] Cancelled — stopping send loop`);
    emitToNumber(numberId, "campaign.cancelled", { campaignId });
    return;
  }
  if (stopSignal === "PAUSED") {
    console.log(`[Campaign ${campaignId}] Paused — stopping send loop`);
    emitToNumber(numberId, "campaign.paused", { campaignId });
    return;
  }
  if (stopSignal === "QUIET_HOURS") {
    await pauseForQuietHours(campaignId, numberId);
    return;
  }
  if (stopSignal === "SEND_ERROR") {
    const detail = systemicErrors.get(campaignId) || "Meta refused the send";
    systemicErrors.delete(campaignId);
    console.error(`[Campaign ${campaignId}] paused on account-wide send error — ${detail}`);
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: "RUNNING" },
      data: { status: "PAUSED", pauseReason: "SEND_ERROR", pauseDetail: detail },
    });
    emitToNumber(numberId, "campaign.paused", { campaignId, reason: "SEND_ERROR", detail });
    logAudit({
      action: "CAMPAIGN_PAUSED",
      actor: null,
      targetType: "Campaign",
      targetId: campaignId,
      details: { reason: "SEND_ERROR", detail },
    });
    return;
  }

  // Only mark COMPLETED if still RUNNING — a cancel/pause that landed after
  // the last recipient's check must not be overwritten.
  const finished = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "RUNNING" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (finished.count > 0) {
    emitToNumber(numberId, "campaign.completed", { campaignId });
  }
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
      where: { whatsappNumberId: req.numberId },
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

    const deliveredMap = {};
    deliveredRaw.forEach((r) => { deliveredMap[r.campaignId] = r; });

    const repliedMap = {};
    repliedRaw.forEach((r) => { repliedMap[r.campaignId] = Number(r.replied); });

    const enriched = campaigns.map((c) => ({
      ...c,
      deliveredCount: Number(deliveredMap[c.id]?.delivered || 0),
      readCount: Number(deliveredMap[c.id]?.read_count || 0),
      repliedCount: repliedMap[c.id] || 0,
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
      where: { id, whatsappNumberId: req.numberId },
      include: {
        template: true,
        segment: { select: { id: true, name: true, description: true } },
        flow: { select: { id: true, name: true, isActive: true } },
        recipients: {
          include: { customer: { select: { id: true, name: true, phone: true, tags: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));

    // The same three figures getCampaigns computes for the list. The detail page
    // shows them as stat cards, and they read 0 while only the list set them.
    const [delivered, read, repliedCount] = await Promise.all([
      prisma.campaignRecipient.count({ where: { campaignId: id, message: { status: { in: ["DELIVERED", "READ"] } } } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, message: { status: "READ" } } }),
      prisma.campaignRecipient.count({ where: { campaignId: id, repliedAt: { not: null } } }),
    ]);

    res.status(200).json({
      success: true,
      data: { ...campaign, deliveredCount: delivered, readCount: read, repliedCount },
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
    const quietErr = quietHoursScheduleError(scheduledAt);
    if (quietErr) return next(quietErr);

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
    const audience = await resolveAudience({ segmentId: existing.segmentId });

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
    const quietErr = quietHoursScheduleError(scheduledAt);
    if (quietErr) return next(quietErr);

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
    if (segmentId !== undefined || (recipientIds && Array.isArray(recipientIds))) {
      const audience = await resolveAudience({ segmentId, recipientIds });
      await prisma.campaignRecipient.deleteMany({ where: { campaignId: id } });
      data.totalRecipients = audience.ids.length;
      data.segmentId = audience.segmentId;
      data.audienceSnapshot = audience.snapshot;
      data.recipients = { create: audience.ids.map((cid) => ({ customerId: cid })) };
    }

    const campaign = await prisma.campaign.update({
      where: { id },
      data,
      include: {
        template: { select: { id: true, name: true, category: true } },
        segment: { select: { id: true, name: true } },
        flow: { select: { id: true, name: true, isActive: true } },
      },
    });

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

const deleteCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.campaign.findFirst({ where: { id, whatsappNumberId: req.numberId } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    if (!DELETABLE_STATUSES.includes(existing.status)) {
      return next(new AppError(`Can't delete a ${existing.status} campaign — cancel it first`, 400));
    }
    const delErr = assertAgentMayEdit(existing, req.user);
    if (delErr) return next(delErr);

    await prisma.campaign.delete({ where: { id } });

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

    const result = await prisma.campaign.deleteMany({
      where: {
        id: { in: parsedIds },
        status: { in: DELETABLE_STATUSES },
        // Scoped so a list of ids cannot reach across into another line's
        // campaigns. Silently skipping them matches this handler's existing
        // partial-success contract.
        whatsappNumberId: req.numberId,
      },
    });

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

    campaignStopSignals.set(id, "CANCELLED");
    await prisma.campaign.update({ where: { id }, data: { status: "CANCELLED" } });
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

    campaignStopSignals.set(id, "PAUSED");
    const { count } = await prisma.campaign.updateMany({
      where: { id, status: "RUNNING" },
      data: { status: "PAUSED", pauseReason: "MANUAL", pauseDetail: null },
    });
    if (count === 0) {
      campaignStopSignals.delete(id);
      return next(new AppError("Only RUNNING campaigns can be paused", 400));
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

    const { count } = await prisma.campaign.updateMany({
      where: { id, status: "PAUSED" },
      data: { status: "RUNNING", pauseReason: null, pauseDetail: null },
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
      include: { template: { select: { id: true, name: true, wabaId: true, approvalStatus: true } } },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (campaign.status !== "DRAFT") {
      return next(new AppError("Only a DRAFT campaign can be submitted for approval", 400));
    }
    const ownErr = assertAgentMayEdit(campaign, req.user);
    if (ownErr) return next(ownErr);
    // Re-checked here as well as at create time: updateCampaign can re-point a
    // DRAFT at a different template, and approval is the send authorization.
    numbers.assertTemplateUsable(campaign.template, req.number);
    if (campaign.totalRecipients === 0) {
      return next(new AppError("Add at least one recipient before submitting for approval", 400));
    }
    if (campaign.template?.approvalStatus !== "APPROVED") {
      return next(new AppError("The campaign's template must be approved by Meta first", 400));
    }

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

    // A future scheduledAt hands the campaign to the cron scheduler; anything
    // else (absent, or already past) sends now.
    const sendNow = !campaign.scheduledAt || campaign.scheduledAt <= new Date();

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
