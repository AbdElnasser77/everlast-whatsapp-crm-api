const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const { listRequests, getCounts, getRequest, claim, book, notBooked, reopen, setSource, getSourceOptions } = require("./bookingRequest.controller");

const router = express.Router();

// Scoped to the line in view, like the inbox. Anyone who handles chats.
router.use(protect, resolveNumber());

router.get("/", requirePermission("conversation:read"), listRequests);
router.get("/counts", requirePermission("conversation:read"), getCounts);
router.get("/source-options", requirePermission("conversation:read"), getSourceOptions);
router.get("/:id", requirePermission("conversation:read"), getRequest);
router.post("/:id/claim", requirePermission("conversation:write"), claim);
router.post("/:id/book", requirePermission("conversation:write"), book);
router.post("/:id/not-booked", requirePermission("conversation:write"), notBooked);
router.post("/:id/reopen", requirePermission("conversation:write"), reopen);
router.put("/:id/source", requirePermission("conversation:write"), setSource);

module.exports = router;
