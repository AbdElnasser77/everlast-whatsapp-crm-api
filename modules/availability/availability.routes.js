const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getDays, getDay, checkSlot, parseText } = require("./availability.controller");

const router = express.Router();

// The clinic's free times aren't tied to a WhatsApp line. conversation:read is
// held by everyone who either builds flows or works booking requests.
router.use(protect, requirePermission("conversation:read"));

router.get("/days", getDays);
router.get("/day", getDay);
router.get("/check", checkSlot);
router.get("/parse", parseText);

module.exports = router;
