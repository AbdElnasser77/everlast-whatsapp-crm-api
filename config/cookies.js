// Shared so middleware/auth.js can clear the auth cookie on a deactivated or
// deleted account. clearCookie must be passed the same options the cookie was
// set with, or the browser keeps re-sending a dead token.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 8 * 60 * 60 * 1000, // 8 hours in ms
};

module.exports = { COOKIE_OPTIONS };
