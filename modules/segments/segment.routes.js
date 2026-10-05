const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const {
  getFilterFields,
  getFilterOptions,
  previewSegment,
  getAllSegments,
  getSegmentById,
  createSegment,
  updateSegment,
  deleteSegment,
  getSegmentMemberIds,
  getSegmentMembers,
} = require("./segment.controller");

const router = express.Router();

// optional: segment rules are evaluated against the active number, but a
// segment can still be read and edited before any number is selected.
router.use(protect, resolveNumber({ optional: true }));

// Guarded with requirePermission rather than requireRole, unlike the older
// route files that still call the latter. This module is new, so it starts on
// the permission model instead of needing migrating off the role model later;
// the two coexist fine while the rest of the routes are moved across.
//
// The practical consequence is who can do this work. Under requireRole("ADMIN")
// the segmentation engine was admin-only, which made MARKETING — the role the
// feature exists to serve — unable to build the audiences it sends to. Reads
// are open to agents as well, mirroring how list:read is granted: looking at an
// audience is a different act from authoring the rule a bulk send targets.

// ── Rule vocabulary (must precede "/:id") ──────────────────────────────────
router.get("/fields", requirePermission("segment:read"), getFilterFields);
router.get("/options", requirePermission("segment:read"), getFilterOptions);

// ── Ad-hoc preview: count an unsaved rule (must precede "/:id") ────────────
// POST rather than GET because a definition is a nested object, and it is a
// read either way — hence segment:read, not segment:write. Each call is a
// COUNT plus a 12-row sample.
router.post("/preview", requirePermission("segment:read"), previewSegment);

// ── CRUD ───────────────────────────────────────────────────────────────────
router.get("/", requirePermission("segment:read"), getAllSegments);
router.post("/", requirePermission("segment:write"), createSegment);
router.get("/:id", requirePermission("segment:read"), getSegmentById);
router.put("/:id", requirePermission("segment:write"), updateSegment);
router.delete("/:id", requirePermission("segment:write"), deleteSegment);

// ── Resolution ─────────────────────────────────────────────────────────────
router.get("/:id/members", requirePermission("segment:read"), getSegmentMembers);
router.get("/:id/members/ids", requirePermission("segment:read"), getSegmentMemberIds);

module.exports = router;
