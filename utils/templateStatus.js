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
const { emitGlobal } = require("./socket");
const logAudit = require("./audit");

const getApiVersion = () => process.env.WHATSAPP_API_VERSION || "v19.0";

// Returns true when the status actually changed (and a notification went out).
async function applyTemplateStatus(template, status, reason = null, source = "sync") {
  if (status !== "APPROVED" && status !== "REJECTED") return false;
  // Status-guarded: if another route already recorded this decision, the
  // update matches nothing and nobody is notified twice.
  const { count } = await prisma.template.updateMany({
    where: { id: template.id, approvalStatus: { not: status } },
    data: {
      approvalStatus: status,
      rejectionReason: status === "REJECTED" ? reason : null,
      statusChangedAt: new Date(),
    },
  });
  if (count === 0) return false;

  console.log(`[Templates] "${template.name}" ${status} by Meta (via ${source})`);
  emitGlobal("template.status_changed", {
    templateId: template.id,
    name: template.name,
    status,
    reason: status === "REJECTED" ? reason : null,
  });
  logAudit({
    action: status === "APPROVED" ? "TEMPLATE_APPROVED" : "TEMPLATE_REJECTED",
    actor: null,
    targetType: "Template",
    targetId: template.id,
    details: { name: template.name, reason, source },
  });
  return true;
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

module.exports = { applyTemplateStatus, syncSubmittedTemplates, handleTemplateStatusWebhook };
