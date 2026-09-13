const AppError = require("../utils/AppError");
const { ALL_PERMISSIONS, roleHasPermission } = require("../config/permissions");

// Variadic with ALL semantics: requirePermission("list:write", "contact:import")
// means the caller needs both. There is currently no route needing "any of".
//
// Replaces middleware/roles.js. requireRole was de facto an isAdmin gate — all
// 23 call sites passed exactly "ADMIN" — so route files said *who* could call
// them instead of *what* the call does.
const requirePermission = (...permissions) => {
  // Validated at module load, not per request: a typo in a route file becomes a
  // boot-time crash instead of a permanent 403 nobody notices.
  for (const p of permissions) {
    if (!ALL_PERMISSIONS.includes(p)) {
      throw new Error(`requirePermission: unknown permission "${p}"`);
    }
  }

  return (req, res, next) => {
    // Mounted before protect(), or protect() failed to populate req.user.
    // Guarding avoids a TypeError surfacing as a 500 instead of a 401.
    if (!req.user?.role) return next(new AppError("No token provided", 401, "NO_TOKEN"));

    const missing = permissions.filter((p) => !roleHasPermission(req.user.role, p));
    if (missing.length > 0) {
      return next(
        new AppError(`Forbidden: requires ${missing.join(", ")}`, 403, "FORBIDDEN"),
      );
    }
    next();
  };
};

module.exports = requirePermission;
