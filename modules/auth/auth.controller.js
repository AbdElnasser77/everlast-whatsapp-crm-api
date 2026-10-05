const jwt = require("jsonwebtoken");
const bcryptjs = require("bcryptjs");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { permissionsFor } = require("../../config/permissions");

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 8 * 60 * 60 * 1000, // 8 hours in ms
};

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return next(new AppError("Username and password are required", 400));
    }

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return next(new AppError("Invalid credentials", 401));

    const isMatch = await bcryptjs.compare(password, user.passwordHash);
    if (!isMatch) return next(new AppError("Invalid credentials", 401));
    // Checked after the password, so this can't be used to discover which
    // usernames exist. Previously a deactivated account was issued a token and
    // only rejected on its next request.
    if (!user.isActive) {
      return next(new AppError("This account has been deactivated", 401, "ACCOUNT_DEACTIVATED"));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "ONLINE", lastActiveAt: new Date() },
    });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" },
    );

    res.cookie("token", token, COOKIE_OPTIONS);

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        permissions: permissionsFor(user.role),
        status: "ONLINE",
      },
    });
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { status: "OFFLINE" },
    });

    res.clearCookie("token", COOKIE_OPTIONS);
    res.status(200).json({ success: true, message: "Logged out" });
  } catch (err) {
    next(err);
  }
};

module.exports = { login, logout };
