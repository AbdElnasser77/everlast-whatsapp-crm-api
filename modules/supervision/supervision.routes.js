const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getOverview, getConversations, getConversationTimeline, getBookings, getActivity } = require("./supervision.controller");

const router = express.Router();

// Supervisors (team:supervise) and admins. Across all numbers — not scoped by
// the number switcher; ?numberId= narrows when wanted.
router.use(protect, requirePermission("team:supervise"));

router.get("/overview", getOverview);
router.get("/conversations", getConversations);
router.get("/conversations/:id", getConversationTimeline);
router.get("/bookings", getBookings);
router.get("/activity", getActivity);

module.exports = router;
