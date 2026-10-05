const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const {
  getCampaigns,
  getActiveCampaignProgress,
  getQuietHours,
  getCampaign,
  getCampaignReplies,
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
  refreshCampaignAudience,
  setCampaignFlow,
} = require("./campaign.controller");

const router = express.Router();

router.use(protect, resolveNumber());

// Permission model: role x status, not role alone.
//
//   An AGENT may build and submit — create a DRAFT, edit or delete a DRAFT
//   they created, test-send it, and hand it over for review. The controller
//   enforces the ownership and stage rules, since they depend on the row.
//
//   Only an ADMIN may authorize a send: approve, reject, send directly,
//   schedule, pause, resume, cancel, or bulk-delete. Approving is itself the
//   send authorization, so a campaign is frozen to agents from
//   PENDING_APPROVAL onward and its recipient list can't change after review.

// ── Reads: open, so the inbox has campaign context for a reply ─────────────
router.get("/", requirePermission("campaign:read"), getCampaigns);
// Must come before "/:id" — otherwise Express would match "active-progress"
// as an :id param and route it to getCampaign instead.
router.get("/active-progress", requirePermission("campaign:read"), getActiveCampaignProgress);
router.get("/quiet-hours", requirePermission("campaign:read"), getQuietHours);

// ── Collection-level writes (must precede "/:id") ──────────────────────────
// Must come before "/:id" so "bulk-delete" isn't captured as an :id param.
router.post("/bulk-delete", requirePermission("campaign:control"), bulkDeleteCampaigns);
// Likewise "test-send" — it takes no campaign id, it sends one template to one
// number. Open to agents: building a campaign you can't preview is the problem
// this exists to solve. Every call is audited.
router.post("/test-send", requirePermission("campaign:write"), testSendTemplate);

// Flow builder (campaign automations). Before "/:id" so "flows" isn't an id.
router.use("/flows", require("../flows/flow.routes"));

router.get("/:id", requirePermission("campaign:read"), getCampaign);
router.get("/:id/replies", requirePermission("campaign:read"), getCampaignReplies);

// ── Building: agent-accessible, stage-checked in the controller ────────────
router.post("/", requirePermission("campaign:write"), createCampaign);
router.put("/:id", requirePermission("campaign:write"), updateCampaign);
router.put("/:id/flow", requirePermission("campaign:write"), setCampaignFlow);
router.delete("/:id", requirePermission("campaign:write"), deleteCampaign);
router.post("/:id/submit", requirePermission("campaign:write"), submitCampaign);
// Re-run a DRAFT's segment against current data. DRAFT-only, enforced in the
// controller — after review the audience is what was reviewed.
router.post("/:id/refresh-audience", requirePermission("campaign:write"), refreshCampaignAudience);

// ── Authorizing a send: admin only ────────────────────────────────────────
router.post("/:id/approve", requirePermission("campaign:send"), approveCampaign);
router.post("/:id/reject", requirePermission("campaign:send"), rejectCampaign);
router.post("/:id/send", requirePermission("campaign:send"), sendCampaignNow);
router.post("/:id/cancel", requirePermission("campaign:control"), cancelCampaign);
router.post("/:id/pause", requirePermission("campaign:control"), pauseCampaign);
router.post("/:id/resume", requirePermission("campaign:control"), resumeCampaign);

module.exports = router;
