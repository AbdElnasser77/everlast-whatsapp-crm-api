const express = require("express");
const multer = require("multer");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const { getAllCustomers, getFilteredCustomerIds, getCustomerById, createCustomer, updateCustomer, validateImport, importCustomers, deleteCustomer, bulkDeleteCustomers } = require("./customer.controller");

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

router.get("/", requirePermission("contact:read"), getAllCustomers);
// Must precede "/:id" so "ids" isn't captured as an :id param. Resolves the
// current filter to every matching id, which is what "select all matches" needs.
router.get("/ids", requirePermission("contact:read"), getFilteredCustomerIds);
router.post("/import/validate", requirePermission("contact:import"), upload.single("file"), validateImport);
router.post("/import", requirePermission("contact:import"), upload.single("file"), importCustomers);
router.post("/bulk-delete", requirePermission("contact:bulk_delete"), bulkDeleteCustomers);
router.get("/:id", requirePermission("contact:read"), getCustomerById);
router.post("/", requirePermission("contact:write"), createCustomer);
router.put("/:id", requirePermission("contact:write"), updateCustomer);
router.delete("/:id", requirePermission("contact:delete"), deleteCustomer);

module.exports = router;
