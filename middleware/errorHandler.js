const crypto = require("crypto");
const AppError = require("../utils/AppError");

// Prisma connection-level failures. protect() now awaits a database read on
// every request, so a database outage would otherwise surface as a wall of
// opaque 500s.
const DB_UNAVAILABLE = new Set(["P1001", "P1002", "P1008", "P1017"]);

// Prisma errors that mean "the request doesn't fit the data", not "the code
// broke". Answered with a plain message — never Prisma's own text, which
// names tables, columns and file paths.
const PRISMA_CLIENT_ERRORS = {
  P2025: [404, "Not found — it may have just been deleted"],
  P2002: [409, "That already exists"],
  P2003: [409, "It's still linked to something else, or something it points to no longer exists"],
};

// Whose message may reach the browser as-is. AppError messages are written for
// users on purpose; body-parser / multer / http-errors flag theirs as safe
// (expose) and they describe the request, not the server. Everything else —
// a TypeError, a Prisma invocation dump, an axios error from Meta — is
// internal and only goes to the log.
const isExposable = (err) =>
  err instanceof AppError || err.expose === true || err.name === "MulterError";

const errorHandler = (err, req, res, next) => {
  // One id ties what the user sees to the log line, so "it said reference
  // 3f2a…" is enough to find the real error.
  const requestId = crypto.randomBytes(4).toString("hex");
  const who = req.user ? `user ${req.user.id} (${req.user.username})` : "anonymous";

  // Infrastructure, not a bug — 503 lets ops tell "database is down" apart from
  // "the code threw".
  if (DB_UNAVAILABLE.has(err.code)) {
    console.error(`[${requestId}] 503 ${req.method} ${req.originalUrl} — ${who} — database unavailable (${err.code})`);
    return res.status(503).json({
      success: false,
      message: "Service temporarily unavailable",
      code: "DB_UNAVAILABLE",
      requestId,
    });
  }

  const prismaMapped = PRISMA_CLIENT_ERRORS[err.code];
  const statusCode = err.statusCode || err.status || (prismaMapped ? prismaMapped[0] : 500);

  let message;
  if (isExposable(err) && statusCode < 500) message = err.message;
  else if (prismaMapped && statusCode < 500) message = prismaMapped[1];
  else if (err instanceof AppError) message = err.message; // a 5xx the code chose to word for users
  else message = `Something went wrong on our side. Reference: ${requestId}`;

  if (statusCode >= 500) {
    // The whole error, stack included — this is the only place it is recorded.
    console.error(`[${requestId}] ${statusCode} ${req.method} ${req.originalUrl} — ${who}`);
    console.error(err);
  } else if (prismaMapped) {
    // Expected often enough to be noise as an error, but worth a trace.
    console.warn(`[${requestId}] ${statusCode} ${req.method} ${req.originalUrl} — ${who} — Prisma ${err.code}`);
  }

  const response = { success: false, message, requestId };
  if (err.errorCode) response.code = err.errorCode;
  if (err.details && isExposable(err)) response.details = err.details;

  if (process.env.NODE_ENV === "development") {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
