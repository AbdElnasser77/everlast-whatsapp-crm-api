const express = require("express");
const protect = require("../../middleware/auth");
const requirePermission = require("../../middleware/permissions");
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  resetPassword,
  deleteUser,
  getMe,
  getAssignableUsers,
  updateMyStatus,
  changeMyPassword,
  updateMyProfile,
  handOverMine,
} = require("./user.controller");

const router = express.Router();

router.use(protect);

// Self-service (any logged-in user)
router.get("/me", getMe);
// Before "/:id", or "assignable" would be read as a user id.
router.get("/assignable", requirePermission("conversation:assign"), getAssignableUsers);
router.put("/me/status", updateMyStatus);
router.put("/me/password", changeMyPassword);
router.put("/me", updateMyProfile);
// End of shift: my open chats and booking requests to a colleague or the queue.
router.post("/me/hand-over", requirePermission("conversation:write"), handOverMine);

// Admin only
router.get("/", requirePermission("user:read"), getAllUsers);
router.post("/", requirePermission("user:write"), createUser);
router.get("/:id", requirePermission("user:read"), getUserById);
router.put("/:id", requirePermission("user:write"), updateUser);
router.put("/:id/password", requirePermission("user:write"), resetPassword);
router.delete("/:id", requirePermission("user:write"), deleteUser);

module.exports = router;
