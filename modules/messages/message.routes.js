const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const { sendMessage, searchMessages, getMessageMedia, deleteMessage } = require("./message.controller");

const router = express.Router();

router.use(protect, resolveNumber());

router.get("/search", requirePermission("conversation:read"), searchMessages);
router.post("/send", requirePermission("message:send"), sendMessage);
router.get("/:id/media", requirePermission("conversation:read"), getMessageMedia);
router.delete("/:id", requirePermission("message:delete_own"), deleteMessage);

module.exports = router;
