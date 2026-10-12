// Quiet hours: the daily window in which campaign messages must not be sent.
//
// One business-wide window in one timezone (default 21:00–09:00 Asia/Dubai).
// Configured through QUIET_HOURS_START / QUIET_HOURS_END / QUIET_HOURS_TZ in
// config.env. Unset uses the default; set either bound to an empty string to
// turn the feature off.
//
// Enforced in processCampaign and the scheduler — every send funnels through
// there. The API and UI only explain the rule, they are not what stops a send.
//
// Arithmetic is in whole minutes of the local day, which is exact for zones
// without DST (Asia/Dubai has none). In a DST zone nextSendWindowOpen can be
// off by the shift on the changeover night.

const DEFAULTS = { start: "21:00", end: "09:00", timezone: "Asia/Dubai" };

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Saved from Settings → Quiet hours, if an admin ever saved it. Required
// lazily so this module stays usable without a database (its own check).
function savedQuietHours() {
  // The checks pin quiet hours through env; a saved setting must not win there.
  if (process.env.QUIET_HOURS_FORCE_ENV === "1") return null;
  try {
    return require("./appSettings").getSetting("quietHours");
  } catch {
    return null;
  }
}

function getQuietHoursConfig() {
  // The Settings page wins over the server config once it has been saved.
  const saved = savedQuietHours();
  if (saved) {
    const startMin = parseHHMM(saved.start);
    const endMin = parseHHMM(saved.end);
    const enabled = saved.enabled && startMin !== null && endMin !== null && startMin !== endMin;
    return { start: saved.start, end: saved.end, timezone: saved.timezone, enabled, startMin, endMin, source: "settings" };
  }
  const start = process.env.QUIET_HOURS_START ?? DEFAULTS.start;
  const end = process.env.QUIET_HOURS_END ?? DEFAULTS.end;
  const timezone = process.env.QUIET_HOURS_TZ || DEFAULTS.timezone;
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  const enabled = startMin !== null && endMin !== null && startMin !== endMin;
  return { start, end, timezone, enabled, startMin, endMin, source: "server" };
}

// Minutes since local midnight in the configured timezone.
function localMinuteOfDay(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

function isQuietHours(date = new Date(), config = getQuietHoursConfig()) {
  if (!config.enabled) return false;
  const m = localMinuteOfDay(date, config.timezone);
  const { startMin, endMin } = config;
  // A window that crosses midnight (21:00–09:00) is "after start OR before end".
  return startMin > endMin ? m >= startMin || m < endMin : m >= startMin && m < endMin;
}

// The moment sending is next allowed: `date` itself when that is outside quiet
// hours, otherwise the upcoming end of the window.
function nextSendWindowOpen(date = new Date(), config = getQuietHoursConfig()) {
  if (!isQuietHours(date, config)) return date;
  const m = localMinuteOfDay(date, config.timezone);
  const minutesLeft = (config.endMin - m + 1440) % 1440;
  const startOfMinute = Math.floor(date.getTime() / 60000) * 60000;
  return new Date(startOfMinute + minutesLeft * 60000);
}

module.exports = { getQuietHoursConfig, isQuietHours, nextSendWindowOpen, localMinuteOfDay };
