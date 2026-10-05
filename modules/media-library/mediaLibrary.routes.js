const express = require("express");
const multer = require("multer");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getAllMedia, uploadMedia, updateMedia, deleteMedia } = require("./mediaLibrary.controller");
const { MAX_FILE_SIZE, mediaFileFilter } = require("../../utils/mediaHelpers");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: mediaFileFilter,
});

const router = express.Router();

router.use(protect);

router.get("/", requirePermission("media:read"), getAllMedia);
router.post("/", requirePermission("media:write"), upload.single("file"), uploadMedia);
router.put("/:id", requirePermission("media:write"), updateMedia);
router.delete("/:id", requirePermission("media:write"), deleteMedia);

module.exports = router;
