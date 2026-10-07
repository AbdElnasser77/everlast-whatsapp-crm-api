const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const {
  getAllConversations,
  getConversationCounts,
  getConversationMessages,
  markConversationRead,
  sendConversationTyping,
  getConversationProfile,
  assignConversation,
  changeConversationStatus,
  createOrGetConversation,
} = require("./conversation.controller");

const router = express.Router();

router.use(protect, resolveNumber());

router.get("/", requirePermission("conversation:read"), getAllConversations);
router.get("/counts", requirePermission("conversation:read"), getConversationCounts);
router.post("/", requirePermission("conversation:write"), createOrGetConversation);
router.get("/:id/messages", requirePermission("conversation:read"), getConversationMessages);
router.get("/:id/profile", requirePermission("conversation:read"), getConversationProfile);
router.post("/:id/read", requirePermission("conversation:write"), markConversationRead);
router.post("/:id/typing", requirePermission("conversation:write"), sendConversationTyping);
router.put("/:id/assign", requirePermission("conversation:assign"), assignConversation);
router.put("/:id/status", requirePermission("conversation:write"), changeConversationStatus);

module.exports = router;
