class AppError extends Error {
  // errorCode is an optional machine-readable tag surfaced to the client as
  // `code`. It exists so the frontend can tell "token expired" from "account
  // deactivated" — both are 401s with different correct responses. Named
  // errorCode rather than code to avoid colliding with Prisma's err.code, which
  // errorHandler also inspects.
  // details: optional structured context for the client, e.g. which template
  // field Meta rejected ({ field: "header" }).
  constructor(message, statusCode, errorCode, details) {
    super(message);
    this.statusCode = statusCode;
    if (errorCode) this.errorCode = errorCode;
    if (details) this.details = details;
  }
}

module.exports = AppError;
