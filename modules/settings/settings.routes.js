const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const {
  getSettings,
  updateSetting,
  listNumbers,
  createNumber,
  updateNumber,
  checkQualityNow,
} = require("./settings.controller");

const router = express.Router();

// The whole Settings area is admin-only: settings:write and number:write are
// granted to ADMIN alone (config/permissions.js).
router.use(protect);

router.get("/", requirePermission("settings:write"), getSettings);

router.get("/numbers", requirePermission("number:write"), listNumbers);
router.post("/numbers", requirePermission("number:write"), createNumber);
router.post("/numbers/check-quality", requirePermission("number:write"), checkQualityNow);
router.put("/numbers/:id", requirePermission("number:write"), updateNumber);

router.put("/:key", requirePermission("settings:write"), updateSetting);

module.exports = router;
