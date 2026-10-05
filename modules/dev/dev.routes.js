const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getBilling } = require("./dev.controller");

// Development-only tools. app.js mounts this router only when NODE_ENV is not
// "production", so none of these endpoints exist on the live server.
const router = express.Router();

router.use(protect, requirePermission("dev:tools")); // admins only
router.get("/billing", getBilling);

module.exports = router;
