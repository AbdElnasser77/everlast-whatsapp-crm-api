// Prisma connection-level failures. protect() now awaits a database read on
// every request, so a database outage would otherwise surface as a wall of
// opaque 500s.
const DB_UNAVAILABLE = new Set(["P1001", "P1002", "P1008", "P1017"]);

const errorHandler = (err, req, res, next) => {
  // Infrastructure, not a bug — 503 lets ops tell "database is down" apart from
  // "the code threw".
  if (DB_UNAVAILABLE.has(err.code)) {
    return res.status(503).json({
      success: false,
      message: "Service temporarily unavailable",
      code: "DB_UNAVAILABLE",
    });
  }

  const statusCode = err.statusCode || 500;
  const response = { success: false, message: err.message || "Internal Server Error" };
  if (err.errorCode) response.code = err.errorCode;
  if (err.details) response.details = err.details;

  if (process.env.NODE_ENV === "development") {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
