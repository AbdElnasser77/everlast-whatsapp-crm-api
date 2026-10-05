const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getAuditLogs } = require("./audit.controller");

const router = express.Router();

router.use(protect, requirePermission("audit:read"));

router.get("/", getAuditLogs);

module.exports = router;
