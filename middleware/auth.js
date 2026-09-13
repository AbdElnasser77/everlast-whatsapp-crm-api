const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const AppError = require("../utils/AppError");
const { COOKIE_OPTIONS } = require("../config/cookies");
const { permissionsFor } = require("../config/permissions");

const protect = async (req, res, next) => {
  // read from cookie first, fall back to Authorization header (for Swagger/API clients)
  const token =
    req.cookies?.token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null);

  if (!token) return next(new AppError("No token provided", 401, "NO_TOKEN"));

  // Split from the DB call below on purpose: the old single try/catch reported
  // *any* failure — including a database error — as "Invalid or expired token".
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next(new AppError("Invalid or expired token", 401, "TOKEN_INVALID"));
  }

  // One awaited round-trip replaces the old fire-and-forget lastActiveAt write.
  // Same query count as before, but the response now carries the authoritative
  // role and isActive — so a demotion or deactivation takes effect on the
  // user's very next request instead of whenever their 8h token happens to
  // expire. The JWT claims are used for nothing but the id from here on.
  let fresh;
  try {
    fresh = await prisma.user.update({
      where: { id: decoded.id },
      data: { lastActiveAt: new Date() },
      select: { id: true, username: true, role: true, isActive: true },
    });
  } catch (err) {
    // P2025 = "record to update not found": the account was deleted while this
    // token was still live.
    if (err.code === "P2025") {
      res.clearCookie("token", COOKIE_OPTIONS);
      return next(new AppError("Your account no longer exists", 401, "ACCOUNT_DELETED"));
    }
    // Anything else is infrastructure. Fail closed — errorHandler maps Prisma
    // connection errors to 503. Falling back to the JWT's claims here would
    // create a window where inducing database errors buys stale-role
    // authorization, and a DB outage already breaks nearly every endpoint.
    return next(err);
  }

  // 401 rather than 403: the token is technically valid, so 403 is the
  // pedantically correct code — but the desired client behaviour is "log out
  // and show the login screen", and the frontend's 403 path renders an in-app
  // "insufficient permissions" state that would strand the user in a broken
  // shell. Clearing the cookie server-side stops the browser re-sending a dead
  // token.
  if (!fresh.isActive) {
    res.clearCookie("token", COOKIE_OPTIONS);
    return next(new AppError("Your account has been deactivated", 401, "ACCOUNT_DEACTIVATED"));
  }

  req.user = {
    id: fresh.id,
    username: fresh.username,
    role: fresh.role,
    // Frozen shared array from the permission map — one property assignment,
    // no allocation. getMe serves it straight to the frontend.
    permissions: permissionsFor(fresh.role),
  };

  next();
};

module.exports = protect;
