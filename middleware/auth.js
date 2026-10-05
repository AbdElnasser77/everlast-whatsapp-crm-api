const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const AppError = require("../utils/AppError");
const { COOKIE_OPTIONS } = require("../config/cookies");
const { permissionsFor } = require("../config/permissions");

// How stale lastActiveAt may get before we spend a write refreshing it.
const LAST_ACTIVE_WRITE_INTERVAL_MS = 2 * 60 * 1000;

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

  // Authorization still reads the user fresh on EVERY request, so a demotion
  // or deactivation takes effect on the user's very next call rather than
  // whenever their 8h token expires. The JWT claims are used for nothing but
  // the id from here on.
  //
  // This used to be an update() writing lastActiveAt every request, which made
  // each authenticated call a WRITE. Neon suspends idle compute and a cold
  // start costs seconds, so a burst of requests landing on a cold database
  // drained the connection pool ("Timed out fetching a new connection").
  // Reading, and writing lastActiveAt only once it is actually stale, keeps
  // the common path to a single cheap read.
  const fresh = await prisma.user.findUnique({
    where: { id: decoded.id },
    select: { id: true, username: true, role: true, isActive: true, lastActiveAt: true },
  });

  // findUnique returns null where update() threw P2025: the account was
  // deleted while this token was still live.
  if (!fresh) {
    res.clearCookie("token", COOKIE_OPTIONS);
    return next(new AppError("Your account no longer exists", 401, "ACCOUNT_DELETED"));
  }

  // Presence only needs minute-level accuracy, so one write per user per
  // interval is plenty. Not awaited — a failed heartbeat must never break an
  // otherwise valid request, and it is not used for authorization.
  const stale =
    !fresh.lastActiveAt || Date.now() - fresh.lastActiveAt.getTime() > LAST_ACTIVE_WRITE_INTERVAL_MS;
  if (stale) {
    prisma.user
      .update({ where: { id: fresh.id }, data: { lastActiveAt: new Date() } })
      .catch((err) => console.error("lastActiveAt heartbeat failed:", err.message));
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
