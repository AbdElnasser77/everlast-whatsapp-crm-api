const express = require("express");
const multer = require("multer");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const {
  getAllLists,
  createList,
  getListById,
  updateList,
  deleteList,
  addMembers,
  getListMemberIds,
  removeMember,
  validateListImport,
  importListMembers,
} = require("./list.controller");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"), false);
    }
  },
});

const router = express.Router();

router.use(protect);

router.get("/", requirePermission("list:read"), getAllLists);
router.post("/", requirePermission("list:write"), createList);
router.get("/:id", requirePermission("list:read"), getListById);
router.put("/:id", requirePermission("list:write"), updateList);
router.delete("/:id", requirePermission("list:write"), deleteList);

router.post("/:id/members", requirePermission("list:write"), addMembers);
router.get("/:id/members/ids", requirePermission("list:read"), getListMemberIds);
router.delete("/:id/members/:customerId", requirePermission("list:write"), removeMember);

router.post("/:id/import/validate", requirePermission("list:write"), upload.single("file"), validateListImport);
router.post("/:id/import", requirePermission("list:write"), upload.single("file"), importListMembers);

module.exports = router;
