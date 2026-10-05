// WhatsApp's 24-hour customer-service window — the one rule, used by every send
// path so they can't disagree.
//
// A business may send free-form messages (text, media, ad-hoc interactive) only
// within 24 hours of the customer's last message. Outside it — and that
// INCLUDES a conversation where the customer has never written at all, e.g. one
// created by a campaign or started by an agent — the only thing Meta accepts is
// an approved template. Treating "never messaged" as open was the bug: free text
// was allowed there, and Meta rejected it after the fact.

const AppError = require("./AppError");

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {{ open: boolean, expiresAt: Date | null }}
 *   expiresAt is null when the customer has never written.
 */
function windowState(lastCustomerMessageAt, now = Date.now()) {
  if (!lastCustomerMessageAt) return { open: false, expiresAt: null };
  const expiresAt = new Date(new Date(lastCustomerMessageAt).getTime() + WINDOW_MS);
  return { open: expiresAt.getTime() > now, expiresAt };
}

// One error shape for "this send needs an approved template", whichever path
// hit it — the frontend opens the template picker on this code.
function windowClosedError(lastCustomerMessageAt) {
  const message = lastCustomerMessageAt
    ? "The 24-hour messaging window has expired. Send an approved template to re-engage."
    : "This contact hasn't messaged you yet. Start the conversation with an approved template.";
  return new AppError(message, 400, "WINDOW_CLOSED");
}

module.exports = { WINDOW_MS, windowState, windowClosedError };
