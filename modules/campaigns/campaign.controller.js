const { Prisma } = require("@prisma/client");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { sendWhatsAppMessage } = require("../../utils/whatsappClient");
const { getIO } = require("../../utils/socket");
const { buildTemplateParams, resolveNamedVars } = require("../../utils/templateVars");

// How many recipients are sent to WhatsApp at once per campaign. Meta's Cloud
// API throughput ceiling per phone number is far above this (tens of
// messages/sec) — the real safety limit for large sends is the number's
// rolling 24h *unique-recipient* messaging tier, which this concurrency
// setting has no effect on either way. 5 keeps DB/connection-pool load
// predictable while still multiplying throughput several times over the old
// fully-sequential loop. Cancellation below only stops *new* recipients from
// starting; in-flight ones in the same batch are allowed to finish.
const CAMPAIGN_SEND_CONCURRENCY = 5;

// Campaign IDs stopped (cancelled or paused) while a send is in-flight,
// checked in-memory instead of via a DB round-trip per recipient. Maps to
// "CANCELLED" or "PAUSED" so the loop knows which terminal state to leave the
// campaign in once in-flight recipients drain. Single-instance only (matches
// the scheduler's existing single-instance assumption) — fine since both
// pause and cancel are always initiated by an HTTP request handled by this
// same process.
const campaignStopSignals = new Map();

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

// ── Exported for scheduler ──────────────────────────────────────────────────

async function processCampaign(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      template: true,
      recipients: {
        where: { status: "PENDING" },
        include: { customer: true },
      },
    },
  });
  if (!campaign) return;

  campaignStopSignals.delete(campaignId);
  getIO().emit("campaign.started", { campaignId });

  const getStopSignal = () => campaignStopSignals.get(campaignId);

  await runWithConcurrency(campaign.recipients, CAMPAIGN_SEND_CONCURRENCY, getStopSignal, async (recipient) => {
    try {
      if (recipient.customer.optedOut) {
        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: "SKIPPED" },
        });
        return;
      }

      // Get or create conversation
      let conversation = await prisma.conversation.findUnique({
        where: { customerId: recipient.customerId },
        include: { assignedAgent: { select: { id: true, name: true, username: true } } },
      });
      if (!conversation) {
        conversation = await prisma.conversation.create({
          data: { customerId: recipient.customerId, status: "OPEN", unreadCount: 0 },
          include: { assignedAgent: { select: { id: true, name: true, username: true } } },
        });
        getIO().emit("conversation.created", { conversationId: conversation.id });
      }

      const template = campaign.template;
      const customer = recipient.customer;

      const resolvedBody = resolveNamedVars(template.body, customer, null);
      const resolvedHeader = template.headerType === "TEXT" && template.header
        ? resolveNamedVars(template.header, customer, null)
        : null;
      const hasButtons = template.buttons && Array.isArray(template.buttons) && template.buttons.length > 0;
      const needsMetaTemplate = template.category !== "GENERAL" && template.approvalStatus === "APPROVED" && !!template.metaTemplateName;
      const messageType = needsMetaTemplate ? "TEMPLATE" : (hasButtons ? "INTERACTIVE" : "TEXT");

      const templateContent = JSON.stringify({
        headerType: template.headerType,
        header: resolvedHeader || undefined,
        headerMediaUrl: template.headerMediaUrl || undefined,
        body: resolvedBody,
        footer: template.footer || undefined,
        buttons: hasButtons ? template.buttons : undefined,
      });

      // Positional params matching the submitted Meta template (order of appearance).
      const templateVariables = buildTemplateParams(template.body, customer, null);

      let message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderType: "AGENT",
          senderId: null,
          content: templateContent,
          messageType: "INTERACTIVE",
          status: "PENDING",
        },
      });

      try {
        const { whatsappMessageId } = await sendWhatsAppMessage({
          to: customer.phone,
          content: resolvedBody,
          messageType,
          buttons: hasButtons ? template.buttons : null,
          headerType: template.headerType,
          header: resolvedHeader,
          headerMediaUrl: template.headerMediaUrl || null,
          footer: template.footer || null,
          templateName: template.metaTemplateName,
          language: template.language,
          templateVariables,
        });
        message = await prisma.message.update({
          where: { id: message.id },
          data: { whatsappMessageId, status: "SENT" },
        });
      } catch (waErr) {
        console.error(`[Campaign ${campaignId}] WhatsApp send failed for customer ${customer.id}:`, waErr.response?.data || waErr.message);
        await prisma.message.update({ where: { id: message.id }, data: { status: "FAILED" } });
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

      getIO().emit("message.created", { message, conversationId: conversation.id });
      getIO().emit("conversation.updated", { conversationId: conversation.id });
      getIO().emit("campaign.progress", { campaignId, ...updatedCampaign });
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
      getIO().emit("campaign.progress", { campaignId, ...updatedCampaign });
    }
  });

  const stopSignal = getStopSignal();
  campaignStopSignals.delete(campaignId);

  if (stopSignal === "CANCELLED") {
    console.log(`[Campaign ${campaignId}] Cancelled — stopping send loop`);
    getIO().emit("campaign.cancelled", { campaignId });
    return;
  }
  if (stopSignal === "PAUSED") {
    console.log(`[Campaign ${campaignId}] Paused — stopping send loop`);
    getIO().emit("campaign.paused", { campaignId });
    return;
  }

  // Only mark COMPLETED if still RUNNING — a cancel/pause that landed after
  // the last recipient's check must not be overwritten.
  const finished = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "RUNNING" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  if (finished.count > 0) {
    getIO().emit("campaign.completed", { campaignId });
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

const getCampaigns = async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        template: { select: { id: true, name: true, category: true } },
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

    // Single query for replied counts for campaigns that have started
    const repliedRaw = await prisma.$queryRaw`
      SELECT cr."campaignId", COUNT(DISTINCT cr."customerId")::int AS replied
      FROM "CampaignRecipient" cr
      JOIN "Campaign" cam ON cam.id = cr."campaignId"
      JOIN "Conversation" conv ON conv."customerId" = cr."customerId"
      WHERE cr."campaignId" IN (${Prisma.join(campaignIds)})
        AND cam."startedAt" IS NOT NULL
        AND conv."lastSenderType" = 'CUSTOMER'
        AND conv."lastCustomerMessageAt" > cam."startedAt"
      GROUP BY cr."campaignId"
    `;

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
      where: { status: { in: ["RUNNING", "PAUSED"] } },
      select: { id: true, status: true, sentCount: true, failedCount: true, totalRecipients: true },
    });
    res.status(200).json({ success: true, data: campaigns });
  } catch (err) {
    next(err);
  }
};

const getCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        template: true,
        recipients: {
          include: { customer: { select: { id: true, name: true, phone: true, tags: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    res.status(200).json({ success: true, data: campaign });
  } catch (err) {
    next(err);
  }
};

const createCampaign = async (req, res, next) => {
  try {
    const { name, templateId, recipientIds, scheduledAt } = req.body;
    if (!name) return next(new AppError("name is required", 400));
    if (!templateId) return next(new AppError("templateId is required", 400));
    const ids = Array.isArray(recipientIds) ? recipientIds : [];

    const template = await prisma.template.findUnique({ where: { id: parseInt(templateId) } });
    if (!template || !template.isActive) return next(new AppError("Template not found", 404));
    if (template.approvalStatus !== "APPROVED") return next(new AppError("Template must be APPROVED before creating a campaign", 400));

    // Only enforce recipients when actually sending/scheduling
    if (scheduledAt && ids.length === 0) {
      return next(new AppError("recipientIds are required when scheduling a campaign", 400));
    }

    const status = scheduledAt ? "SCHEDULED" : "DRAFT";

    const campaign = await prisma.campaign.create({
      data: {
        name,
        templateId: parseInt(templateId),
        status,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        totalRecipients: ids.length,
        createdById: req.user.id,
        recipients: {
          create: ids.map((cid) => ({ customerId: parseInt(cid) })),
        },
      },
      include: {
        template: { select: { id: true, name: true, category: true } },
      },
    });

    res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    next(err);
  }
};

const updateCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    if (existing.status !== "DRAFT") return next(new AppError("Only DRAFT campaigns can be updated", 400));

    const { name, templateId, recipientIds, scheduledAt } = req.body;

    const data = {};
    if (name) data.name = name;
    if (templateId) data.templateId = parseInt(templateId);
    if (scheduledAt !== undefined) data.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
    if (scheduledAt) data.status = "SCHEDULED";

    if (recipientIds && Array.isArray(recipientIds)) {
      await prisma.campaignRecipient.deleteMany({ where: { campaignId: id } });
      data.totalRecipients = recipientIds.length;
      data.recipients = { create: recipientIds.map((cid) => ({ customerId: parseInt(cid) })) };
    }

    const campaign = await prisma.campaign.update({
      where: { id },
      data,
      include: { template: { select: { id: true, name: true, category: true } } },
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
    const existing = await prisma.campaign.findUnique({ where: { id } });
    if (!existing) return next(new AppError("Campaign not found", 404));
    if (!DELETABLE_STATUSES.includes(existing.status)) {
      return next(new AppError(`Can't delete a ${existing.status} campaign — cancel it first`, 400));
    }

    await prisma.campaign.delete({ where: { id } });
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
      where: { id: { in: parsedIds }, status: { in: DELETABLE_STATUSES } },
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
    const campaign = await prisma.campaign.findUnique({ where: { id } });
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

    // Fire-and-forget
    processCampaign(id).catch((err) => console.error(`[Campaign ${id}] Fatal error:`, err.message));

    res.status(200).json({ success: true, message: "Campaign send started" });
  } catch (err) {
    next(err);
  }
};

const cancelCampaign = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) return next(new AppError("Campaign not found", 404));
    if (!["SCHEDULED", "RUNNING", "PAUSED"].includes(campaign.status)) {
      return next(new AppError("Only SCHEDULED, RUNNING, or PAUSED campaigns can be cancelled", 400));
    }

    campaignStopSignals.set(id, "CANCELLED");
    await prisma.campaign.update({ where: { id }, data: { status: "CANCELLED" } });
    getIO().emit("campaign.cancelled", { campaignId: id });

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
    campaignStopSignals.set(id, "PAUSED");
    const { count } = await prisma.campaign.updateMany({
      where: { id, status: "RUNNING" },
      data: { status: "PAUSED" },
    });
    if (count === 0) {
      campaignStopSignals.delete(id);
      return next(new AppError("Only RUNNING campaigns can be paused", 400));
    }
    getIO().emit("campaign.paused", { campaignId: id });

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
    const { count } = await prisma.campaign.updateMany({
      where: { id, status: "PAUSED" },
      data: { status: "RUNNING" },
    });
    if (count === 0) {
      return next(new AppError("Only PAUSED campaigns can be resumed", 400));
    }
    campaignStopSignals.delete(id);

    // processCampaign only ever touches recipients still PENDING, so resuming
    // is inherently safe — identical to the scheduler's crash-recovery resume.
    processCampaign(id).catch((err) => console.error(`[Campaign ${id}] Fatal error:`, err.message));

    res.status(200).json({ success: true, message: "Campaign resumed" });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCampaigns,
  getActiveCampaignProgress,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  bulkDeleteCampaigns,
  sendCampaignNow,
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  processCampaign,
};
