const bcryptjs = require("bcryptjs");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { ROLES, roleHasPermission } = require("../../config/permissions");
const { disconnectUser } = require("../../utils/socket");
const { handOver, hasHistory } = require("../../utils/handOver");

// Taken from the permission table rather than typed out here. This list was
// once hard-coded to ADMIN and AGENT, which silently made MARKETING impossible
// to create even though the rest of the system knew the role.
const roleError = () => new AppError(`Role must be one of: ${ROLES.join(", ")}`, 400);

const SAFE_SELECT = {
  id: true,
  name: true,
  username: true,
  role: true,
  status: true,
  isActive: true,
  lastActiveAt: true,
  createdAt: true,
  updatedAt: true,
};

// ── Admin: list all users ─────────────────────────────────────────────────────
const getAllUsers = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const where = {};
    if (req.query.role) where.role = req.query.role;
    if (req.query.status) where.status = req.query.status;
    if (req.query.search) {
      where.OR = [
        { name: { contains: req.query.search, mode: "insensitive" } },
        { username: { contains: req.query.search, mode: "insensitive" } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, select: SAFE_SELECT, orderBy: { createdAt: "desc" }, skip, take: limit }),
      prisma.user.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: users,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── Admin: get single user ────────────────────────────────────────────────────
const getUserById = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(req.params.id) },
      select: {
        ...SAFE_SELECT,
        _count: { select: { messages: true, assignedConversations: true } },
      },
    });
    if (!user) return next(new AppError("User not found", 404));
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// ── Admin: create agent ───────────────────────────────────────────────────────
const createUser = async (req, res, next) => {
  try {
    const { name, username, password, role = "AGENT" } = req.body;
    if (!username || !password) return next(new AppError("Username and password are required", 400));
    if (password.length < 8) return next(new AppError("Password must be at least 8 characters", 400));
    if (!ROLES.includes(role)) return next(roleError());

    const passwordHash = await bcryptjs.hash(password, 12);
    const user = await prisma.user.create({
      data: { name, username, passwordHash, role },
      select: SAFE_SELECT,
    });

    logAudit({
      action: "user.created",
      actor: req.user,
      targetType: "user",
      targetId: user.id,
      details: { username: user.username, role: user.role },
    });

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    if (err.code === "P2002") return next(new AppError("Username already taken", 409));
    next(err);
  }
};

// ── Admin: update user ────────────────────────────────────────────────────────
const updateUser = async (req, res, next) => {
  try {
    const { name, username, role, status, isActive, handOverTo } = req.body;
    const targetId = parseInt(req.params.id);
    const before = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, role: true, isActive: true } });
    if (!before) return next(new AppError("User not found", 404));

    const data = {};
    if (name !== undefined) data.name = name;
    if (username !== undefined) data.username = username;
    if (role !== undefined) {
      if (!ROLES.includes(role)) return next(roleError());
      // Changing your own role could only ever lock you out of the screen you
      // are using to change it; another admin has to do it.
      if (Number(req.params.id) === req.user.id && role !== req.user.role) {
        return next(new AppError("You can't change your own role — ask another admin", 400));
      }
      data.role = role;
    }
    if (status !== undefined) {
      if (!["ONLINE", "OFFLINE", "ON_BREAK"].includes(status)) {
        return next(new AppError("Status must be ONLINE, OFFLINE, or ON_BREAK", 400));
      }
      data.status = status;
    }
    // Deactivate (instead of delete): they can't sign in any more, their open
    // chats and booking requests go to `handOverTo` (or back to the queue),
    // and everything they did stays in the history under their name.
    if (isActive !== undefined) {
      if (targetId === req.user.id && isActive === false) {
        return next(new AppError("You can't deactivate your own account", 400));
      }
      data.isActive = Boolean(isActive);
      if (!data.isActive) data.status = "OFFLINE";
    }
    const losesInbox =
      (data.isActive === false && before.isActive) ||
      (data.role && roleHasPermission(before.role, "conversation:write") && !roleHasPermission(data.role, "conversation:write"));
    let handedOver = null;
    if (losesInbox) {
      handedOver = await handOver(targetId, handOverTo ?? null, req.user, { reason: data.isActive === false ? "deactivated" : "role changed" });
    }

    const user = await prisma.user.update({
      where: { id: targetId },
      data,
      select: SAFE_SELECT,
    });
    // Signed out everywhere at once when deactivated or their role changed.
    if (data.isActive === false || (data.role && data.role !== before.role)) disconnectUser(targetId);

    logAudit({
      action: "user.updated",
      actor: req.user,
      targetType: "user",
      targetId: user.id,
      details: { ...data, ...(handedOver ? { handedOver } : {}) },
    });

    res.status(200).json({ success: true, data: user, handedOver });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("User not found", 404));
    if (err.code === "P2002") return next(new AppError("Username already taken", 409));
    next(err);
  }
};

// ── Admin: reset any user's password ─────────────────────────────────────────
const resetPassword = async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return next(new AppError("Password must be at least 8 characters", 400));

    const passwordHash = await bcryptjs.hash(password, 12);
    const user = await prisma.user.update({
      where: { id: parseInt(req.params.id) },
      data: { passwordHash },
      select: SAFE_SELECT,
    });

    logAudit({
      action: "user.password_reset",
      actor: req.user,
      targetType: "user",
      targetId: user.id,
      details: { resetBy: req.user.username },
    });

    res.status(200).json({ success: true, message: "Password reset successfully" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("User not found", 404));
    next(err);
  }
};

// ── Admin: delete user ────────────────────────────────────────────────────────
const deleteUser = async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id);

    if (targetId === req.user.id) {
      return next(new AppError("You cannot delete your own account", 400));
    }
    // Deleting someone who replied, booked or owned chats would blank their
    // name across the history (and drop their replies from response times).
    if (await hasHistory(targetId)) {
      return next(new AppError(
        "This person has chats, replies or bookings in the history. Deactivate them instead — they can't sign in, and their work stays credited to them.",
        409,
        "USER_HAS_HISTORY",
      ));
    }

    await prisma.user.delete({ where: { id: targetId } });

    logAudit({
      action: "user.deleted",
      actor: req.user,
      targetType: "user",
      targetId,
      details: null,
    });

    res.status(200).json({ success: true, message: "User deleted" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("User not found", 404));
    next(err);
  }
};

// ── Self: get own profile ─────────────────────────────────────────────────────
// ── Anyone who can assign: who a conversation can be given to ────────────────
// The agent picker's source. Deliberately not GET /users: that needs user:read,
// which agents don't have, and it lists deactivated accounts too. This returns
// only people who can actually work a conversation — active, and a role that
// can reply — with just enough to pick one (name and presence).
const PRESENCE_ORDER = { ONLINE: 0, ON_BREAK: 1, OFFLINE: 2 };

const getAssignableUsers = async (req, res, next) => {
  try {
    const roles = ROLES.filter((r) => roleHasPermission(r, "conversation:write"));
    const users = await prisma.user.findMany({
      where: { isActive: true, role: { in: roles } },
      select: { id: true, name: true, username: true, status: true },
    });
    // Online people first, then by name, so the likeliest hand-off is on top.
    users.sort(
      (a, b) =>
        (PRESENCE_ORDER[a.status] ?? 9) - (PRESENCE_ORDER[b.status] ?? 9) ||
        (a.name || a.username).localeCompare(b.name || b.username),
    );
    res.status(200).json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
};

const getMe = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        ...SAFE_SELECT,
        _count: { select: { messages: true, assignedConversations: true } },
      },
    });
    // Serve the permission array config/permissions.js says this endpoint
    // serves, so the frontend can gate on capabilities instead of re-deriving
    // them from the role — the one rule that file asks callers to keep.
    // protect() already resolved it from the authoritative role it just read,
    // so this costs nothing and cannot disagree with what the guards enforce.
    res.status(200).json({
      success: true,
      data: { ...user, permissions: req.user.permissions },
    });
  } catch (err) {
    next(err);
  }
};

// ── Self: update own status ───────────────────────────────────────────────────
const updateMyStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["ONLINE", "OFFLINE", "ON_BREAK"].includes(status)) {
      return next(new AppError("Status must be ONLINE, OFFLINE, or ON_BREAK", 400));
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { status },
      select: SAFE_SELECT,
    });

    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// ── Self: end of shift — hand my open chats and booking requests over ───────
// To a colleague (`toUserId`) or back to the shared queue (none given).
const handOverMine = async (req, res, next) => {
  try {
    const result = await handOver(req.user.id, req.body?.toUserId ?? null, req.user, { reason: "end of shift" });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// ── Self: change own display name ─────────────────────────────────────────────
// The name colleagues see on assignments and replies. The username (login)
// is changed by an admin, not here.
const updateMyProfile = async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    if (!name) return next(new AppError("Name can't be empty", 400));
    if (name.length > 60) return next(new AppError("Name must be 60 characters or fewer", 400));
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name },
      select: SAFE_SELECT,
    });
    res.status(200).json({ success: true, data: user });
  } catch (err) {
    next(err);
  }
};

// ── Self: change own password ─────────────────────────────────────────────────
const changeMyPassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return next(new AppError("currentPassword and newPassword are required", 400));
    }
    if (newPassword.length < 8) return next(new AppError("New password must be at least 8 characters", 400));

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const isMatch = await bcryptjs.compare(currentPassword, user.passwordHash);
    // 400, not 401: the browser treats any 401 as "session expired" and signs
    // the user out — a mistyped current password must just say so.
    if (!isMatch) return next(new AppError("Current password is incorrect", 400, "WRONG_PASSWORD"));

    const passwordHash = await bcryptjs.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });

    res.status(200).json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  handOverMine,
  updateMyProfile,
  getAllUsers,
  getAssignableUsers,
  getUserById,
  createUser,
  updateUser,
  resetPassword,
  deleteUser,
  getMe,
  updateMyStatus,
  changeMyPassword,
};
