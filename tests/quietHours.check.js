// Pure check of utils/quietHours.js — no database, no network.
// Run: npm run check:quiet-hours

const { isQuietHours, nextSendWindowOpen, getQuietHoursConfig } = require("../utils/quietHours");

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  ok ? passed++ : failed++;
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${label}${ok ? "" : `  (got ${actual}, expected ${expected})`}`);
}

// Dubai is UTC+4 all year, so "HH:MM Dubai" is a fixed UTC instant.
const dubai = (iso) => new Date(`${iso}+04:00`);

delete process.env.QUIET_HOURS_START;
delete process.env.QUIET_HOURS_END;
delete process.env.QUIET_HOURS_TZ;
const cfg = getQuietHoursConfig();
check("defaults to 21:00–09:00 Asia/Dubai", `${cfg.start}-${cfg.end} ${cfg.timezone} ${cfg.enabled}`, "21:00-09:00 Asia/Dubai true");

check("08:59 is quiet", isQuietHours(dubai("2026-09-28T08:59:00")), true);
check("09:00 is open", isQuietHours(dubai("2026-09-28T09:00:00")), false);
check("14:00 is open", isQuietHours(dubai("2026-09-28T14:00:00")), false);
check("20:59 is open", isQuietHours(dubai("2026-09-28T20:59:59")), false);
check("21:00 is quiet", isQuietHours(dubai("2026-09-28T21:00:00")), true);
check("03:00 is quiet", isQuietHours(dubai("2026-09-28T03:00:00")), true);

check("next open from 23:00 is 09:00 next day",
  nextSendWindowOpen(dubai("2026-09-28T23:00:30")).toISOString(), dubai("2026-09-29T09:00:00").toISOString());
check("next open from 02:00 is 09:00 same day",
  nextSendWindowOpen(dubai("2026-09-28T02:00:00")).toISOString(), dubai("2026-09-28T09:00:00").toISOString());
const noon = dubai("2026-09-28T12:34:56");
check("next open while open is now", nextSendWindowOpen(noon).getTime(), noon.getTime());

// A window that does not cross midnight.
process.env.QUIET_HOURS_START = "13:00";
process.env.QUIET_HOURS_END = "14:00";
check("13:30 quiet in 13:00–14:00", isQuietHours(dubai("2026-09-28T13:30:00")), true);
check("14:00 open in 13:00–14:00", isQuietHours(dubai("2026-09-28T14:00:00")), false);
check("03:00 open in 13:00–14:00", isQuietHours(dubai("2026-09-28T03:00:00")), false);

// Turned off.
process.env.QUIET_HOURS_START = "";
check("empty start disables", getQuietHoursConfig().enabled, false);
check("disabled is never quiet", isQuietHours(dubai("2026-09-28T03:00:00")), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
