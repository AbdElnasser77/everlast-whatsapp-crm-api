const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const {
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  syncApprovalStatus,
  sendTemplate,
} = require("./template.controller");

const router = express.Router();

// This file used to attach `protect` per route, making it the one router that
// did not follow the router.use pattern. Collapsed so number resolution is
// applied uniformly and cannot be forgotten on a route added later.
router.use(protect, resolveNumber());

router.get("/", requirePermission("template:read"), getTemplates);
router.post("/sync", requirePermission("template:write"), syncApprovalStatus);
router.post("/", requirePermission("template:write"), createTemplate);
router.put("/:id", requirePermission("template:write"), updateTemplate);
router.delete("/:id", requirePermission("template:write"), deleteTemplate);
router.post("/:id/submit", requirePermission("template:write"), submitForApproval);

// Send a template in a conversation — :id is conversationId
router.post("/conversations/:id/send-template", requirePermission("message:send"), sendTemplate);

module.exports = router;
