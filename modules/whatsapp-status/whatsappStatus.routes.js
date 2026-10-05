const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { resolveNumber } = require("../../middleware/whatsappNumber");
const { getPhoneNumberStatus, getAllPhoneNumbers, getConfiguredNumbers } = require("./whatsappStatus.controller");

const router = express.Router();

router.use(protect, resolveNumber());

// The switcher's list. Gated on number:read rather than ADMIN — every role needs
// it to render the switcher, and an agent who can answer a line must be able to
// select it.
router.get("/my-numbers", requirePermission("number:read"), getConfiguredNumbers);

router.get("/status", requirePermission("number:read"), getPhoneNumberStatus);
router.get("/numbers", requirePermission("stats:read"), getAllPhoneNumbers);

module.exports = router;
