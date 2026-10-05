// Resolves which WhatsApp line a request is acting on, and puts it on `req`.
//
// The client sends an internal WhatsAppNumber id; it never sends a phone number
// id or a token. The row — and therefore the credentials — is always resolved
// server-side, so a hostile client can at worst name a number it is allowed to
// use anyway.

const numbers = require("../utils/whatsappNumbers");
const AppError = require("../utils/AppError");
const { roleHasPermission } = require("../config/permissions");

const HEADER = "x-whatsapp-number-id";

// v1: any role that can use numbers can use every active number. An agent must
// be able to answer whichever line a customer wrote to — restricting agents
// per-number would strand inbound conversations, which is worse than being
// slightly over-permissive.
//
// When per-brand teams become real, add a UserWhatsAppNumber join table and
// change ONLY this function. Nothing else inspects number access.
function mayUseNumber(user, number) {
  if (!user) return false;
  return roleHasPermission(user.role, "number:use_any");
}

/**
 * @param opts.allowAll  accept the sentinel "all" for cross-number reporting
 *                       (stats only). Sets req.numberScope = "ALL", req.number = null.
 * @param opts.optional  fall through with req.number = null instead of erroring
 *                       when nothing is selected and no default exists.
 */
function resolveNumber(opts = {}) {
  const { allowAll = false, optional = false } = opts;

  return async (req, res, next) => {
    try {
      const raw =
        req.headers[HEADER] ??
        req.query.whatsappNumberId ??
        (req.body && req.body.whatsappNumberId);

      if (allowAll && String(raw).toLowerCase() === "all") {
        req.number = null;
        req.numberId = null;
        req.numberScope = "ALL";
        res.set("X-WhatsApp-Number-Id", "all");
        return next();
      }

      req.numberScope = "NUMBER";

      let number;
      if (raw === undefined || raw === null || raw === "") {
        number = await numbers.getDefault();
        if (!number) {
          if (optional) {
            req.number = null;
            req.numberId = null;
            return next();
          }
          return next(
            new AppError(
              "No WhatsApp number is configured — run `npm run seed:numbers`",
              500,
              "NO_DEFAULT_NUMBER",
            ),
          );
        }
      } else {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0) {
          return next(new AppError("Invalid WhatsApp number id", 400, "NUMBER_INVALID"));
        }
        number = await numbers.getById(id);
        if (!number) {
          return next(new AppError("WhatsApp number not found", 400, "NUMBER_NOT_FOUND"));
        }
        if (!number.isActive) {
          return next(
            new AppError(
              `WhatsApp number "${number.label}" is deactivated`,
              409,
              "NUMBER_INACTIVE",
            ),
          );
        }
      }

      if (!mayUseNumber(req.user, number)) {
        return next(
          new AppError("You do not have access to this WhatsApp number", 403, "NUMBER_FORBIDDEN"),
        );
      }

      // Never the access token. Token retrieval stays an explicit getCredentials()
      // call in the send path, so a token cannot reach an error serializer or a
      // request log by riding along on `req`.
      req.number = {
        id: number.id,
        label: number.label,
        phoneNumberId: number.phoneNumberId,
        wabaId: number.wabaId,
        displayPhoneNumber: number.displayPhoneNumber,
        isDefault: number.isDefault,
        sendConcurrency: number.sendConcurrency,
      };
      req.numberId = number.id;

      // Echoed so the client can discard a response that arrives after the user
      // has switched numbers. Requires cors({ exposedHeaders }) in app.js.
      res.set("X-WhatsApp-Number-Id", String(number.id));

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { resolveNumber, mayUseNumber };
