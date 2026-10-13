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
// The PDF report: figures for a period, and the transcripts the supervisor ticks.
const { getReport, getTranscripts } = require("./report.controller");
router.get("/report", getReport);
router.get("/report/transcripts", getTranscripts);
// The separate, detailed reports.
const { getBookingsReport, getTeamReport, getCampaignsReport, getChatsReport } = require("./reports.controller");
router.get("/reports/bookings", getBookingsReport);
router.get("/reports/team", getTeamReport);
router.get("/reports/campaigns", getCampaignsReport);
router.get("/reports/chats", getChatsReport);

module.exports = router;
