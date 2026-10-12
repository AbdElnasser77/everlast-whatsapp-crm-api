// One place that records Meta's approve/reject decision on a template and
// tells the app about it. Three routes lead here:
//   - the message_template_status_update webhook (instant),
//   - the "Sync" button (POST /api/templates/sync),
//   - jobs/templateStatusSync.js, every 5 minutes, for when webhooks don't
//     arrive (tunnel down, app unpublished).
// All three go through applyTemplateStatus, so the notification fires exactly
// once, whichever route noticed first.

const axios = require("axios");
const prisma = require("../config/prisma");
const numbers = require("./whatsappNumbers");
const { emitGlobal, emitToNumber } = require("./socket");
const logAudit = require("./audit");

const getApiVersion = () => process.env.WHATSAPP_API_VERSION || "v19.0";

// Meta's template events / statuses → ours. Meta can pause an approved
// template (quality), disable it, reinstate it, or delete it; every one of
// those decides whether campaigns can send it.
const META_STATUS = {
  APPROVED: "APPROVED",
  REINSTATED: "APPROVED",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
  PENDING_DELETION: "DISABLED",
  DELETED: "DISABLED",
};
const AUDIT_ACTION = {
  APPROVED: "TEMPLATE_APPROVED",
  REJECTED: "TEMPLATE_REJECTED",
  PAUSED: "TEMPLATE_PAUSED",
  DISABLED: "TEMPLATE_DISABLED",
};

// A template Meta stopped: campaigns sending it right now are paused with the
// reason, instead of finding out through a wall of Meta errors. Their loops
// see the PAUSED status on the next heartbeat. Scheduled ones are caught when
// they start (utils/campaignPreflight.js).
async function pauseCampaignsUsing(template, status, reason) {
  const running = await prisma.campaign.findMany({
    where: { templateId: template.id, status: "RUNNING" },
    select: { id: true, whatsappNumberId: true },
  });
  const detail = `Meta ${status === "PAUSED" ? "paused" : "disabled"} the template "${template.name}"${reason ? ` (${reason})` : ""}`;
  for (const c of running) {
    const { count } = await prisma.campaign.updateMany({
      where: { id: c.id, status: "RUNNING" },
      data: { status: "PAUSED", pauseReason: "TEMPLATE_UNAVAILABLE", pauseDetail: detail },
    });
    if (count === 0) continue;
    console.warn(`[Templates] campaign ${c.id} paused — ${detail}`);
    emitToNumber(c.whatsappNumberId, "campaign.paused", { campaignId: c.id, reason: "TEMPLATE_UNAVAILABLE", detail });
    logAudit({
      action: "CAMPAIGN_PAUSED",
      actor: null,
      targetType: "Campaign",
      targetId: c.id,
      details: { reason: "TEMPLATE_UNAVAILABLE", detail },
    });
  }
}

// Returns true when the status actually changed (and a notification went out).
async function applyTemplateStatus(template, metaStatus, reason = null, source = "sync") {
  const status = META_STATUS[metaStatus];
  if (!status) {
    if (metaStatus === "FLAGGED") {
      // Quality warning: still sendable, but heading for a pause.
      console.warn(`[Templates] "${template.name}" FLAGGED by Meta (low quality) — may be paused soon`);
      emitGlobal("template.status_changed", { templateId: template.id, name: template.name, status: "FLAGGED", reason });
    }
    return false;
  }
  // Status-guarded: if another route already recorded this decision, the
  // update matches nothing and nobody is notified twice.
  const { count } = await prisma.template.updateMany({
    where: { id: template.id, approvalStatus: { not: status } },
    data: {
      approvalStatus: status,
      rejectionReason: status === "APPROVED" ? null : reason,
      statusChangedAt: new Date(),
    },
  });
  if (count === 0) return false;

  console.log(`[Templates] "${template.name}" ${status} by Meta (via ${source})`);
  emitGlobal("template.status_changed", {
    templateId: template.id,
    name: template.name,
    status,
    reason: status === "APPROVED" ? null : reason,
  });
  logAudit({
    action: metaStatus === "REINSTATED" ? "TEMPLATE_REINSTATED" : AUDIT_ACTION[status],
    actor: null,
    targetType: "Template",
    targetId: template.id,
    details: { name: template.name, reason, source, metaStatus },
  });
  if (status === "PAUSED" || status === "DISABLED") await pauseCampaignsUsing(template, status, reason);
  return true;
}

// Meta re-categorised an approved template (e.g. UTILITY → MARKETING). It is
// still sendable, but it now costs and counts as the new category — worth
// knowing before the next campaign. Recorded and announced, nothing blocked.
async function applyTemplateCategory(template, category, source = "sync") {
  if (!category || template.metaCategory === category) return false;
  const { count } = await prisma.template.updateMany({
    where: { id: template.id, OR: [{ metaCategory: null }, { metaCategory: { not: category } }] },
    data: { metaCategory: category },
  });
  if (count === 0) return false;
  // The first time we learn it is not a change worth announcing.
  if (!template.metaCategory) return true;
  console.warn(`[Templates] "${template.name}" re-categorised by Meta: ${template.metaCategory} → ${category} (via ${source})`);
  emitGlobal("template.category_changed", {
    templateId: template.id,
    name: template.name,
    previousCategory: template.metaCategory,
    category,
  });
  logAudit({
    action: "TEMPLATE_RECATEGORISED",
    actor: null,
    targetType: "Template",
    targetId: template.id,
    details: { name: template.name, previousCategory: template.metaCategory, category, source },
  });
  return true;
}

// Webhook value for field "template_category_update":
// { message_template_id, message_template_name, previous_category, new_category }
async function handleTemplateCategoryWebhook(value) {
  const metaId = value?.message_template_id != null ? String(value.message_template_id) : null;
  if (!metaId) return;
  const template = await prisma.template.findFirst({ where: { metaTemplateId: metaId } });
  if (!template) return;
  await applyTemplateCategory(template, value.new_category, "webhook");
}

// Templates that can currently be sent (or were paused) — re-read from Meta
// every 30 minutes, the backstop for a missed pause/disable/recategorise
// webhook. One request per template, so it stays a slow cadence.
async function syncLiveTemplates() {
  const live = await prisma.template.findMany({
    where: { approvalStatus: { in: ["APPROVED", "PAUSED"] }, isActive: true, metaTemplateId: { not: null } },
  });
  const tokensByWaba = new Map();
  for (const wabaId of new Set(live.map((t) => t.wabaId))) {
    try {
      tokensByWaba.set(wabaId, await numbers.getTokenForWaba(wabaId));
    } catch (err) {
      console.error(`Live sync: no usable token for WABA ${wabaId} — ${err.message}`);
    }
  }
  let changed = 0;
  for (const t of live) {
    const token = tokensByWaba.get(t.wabaId);
    if (!token) continue;
    try {
      const metaRes = await axios.get(`https://graph.facebook.com/${getApiVersion()}/${t.metaTemplateId}`, {
        params: { fields: "status,category,rejected_reason" },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      if (await applyTemplateStatus(t, metaRes.data?.status, metaRes.data?.rejected_reason || null, "live-sync")) changed++;
      await applyTemplateCategory(t, metaRes.data?.category, "live-sync");
    } catch (err) {
      console.error(`Live sync failed for template ${t.id} (WABA ${t.wabaId}):`, err.response?.data?.error?.message || err.message);
    }
  }
  return { checked: live.length, changed };
}

// Ask Meta about every SUBMITTED template. Deliberately not scoped to one
// number: a template on a line nobody has selected must still get its answer.
async function syncSubmittedTemplates() {
  const submitted = await prisma.template.findMany({
    where: { approvalStatus: "SUBMITTED", isActive: true },
  });
  let approved = 0;
  let rejected = 0;
  if (submitted.length === 0) return { approved, rejected, checked: 0 };

  // One token per WABA, resolved up front. A template approved under one
  // business account cannot be read with another account's token.
  const tokensByWaba = new Map();
  for (const wabaId of new Set(submitted.map((t) => t.wabaId))) {
    try {
      tokensByWaba.set(wabaId, await numbers.getTokenForWaba(wabaId));
    } catch (err) {
      console.error(`Sync: no usable token for WABA ${wabaId} — ${err.message}`);
    }
  }

  await Promise.all(
    submitted.map(async (t) => {
      if (!t.metaTemplateId) return;
      const token = tokensByWaba.get(t.wabaId);
      if (!token) return;
      try {
        const metaRes = await axios.get(
          `https://graph.facebook.com/${getApiVersion()}/${t.metaTemplateId}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const status = metaRes.data?.status;
        const changed = await applyTemplateStatus(t, status, metaRes.data?.rejected_reason || null, "sync");
        if (changed && status === "APPROVED") approved++;
        if (changed && status === "REJECTED") rejected++;
      } catch (err) {
        // WABA included: without it, "sync silently does nothing for one
        // account" is impossible to diagnose from the logs.
        console.error(`Sync failed for template ${t.id} (WABA ${t.wabaId}):`, err.message);
      }
    }),
  );
  return { approved, rejected, checked: submitted.length };
}

// Webhook value for field "message_template_status_update":
// { event: "APPROVED" | "REJECTED" | "PENDING" | "PAUSED" | ..., message_template_id, reason }
async function handleTemplateStatusWebhook(value) {
  const metaId = value?.message_template_id != null ? String(value.message_template_id) : null;
  if (!metaId) return;
  const template = await prisma.template.findFirst({ where: { metaTemplateId: metaId } });
  if (!template) {
    console.log(`[Templates] status webhook for unknown template ${metaId} (${value.event}) — skipped`);
    return;
  }
  // Meta sends reason "NONE" on approvals.
  const reason = value.reason && value.reason !== "NONE" ? value.reason : null;
  await applyTemplateStatus(template, value.event, reason, "webhook");
}

module.exports = {
  applyTemplateStatus,
  applyTemplateCategory,
  syncSubmittedTemplates,
  syncLiveTemplates,
  handleTemplateStatusWebhook,
  handleTemplateCategoryWebhook,
};
