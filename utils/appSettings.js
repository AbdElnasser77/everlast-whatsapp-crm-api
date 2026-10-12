// Workspace settings changed from the Settings page, stored in AppSetting.
//
// Read synchronously (quiet hours are checked inside tight send loops), so the
// rows live in an in-memory cache: loaded at startup, replaced on every save
// from this process, and re-read every minute so a save made by another
// instance is picked up too. Anything never saved uses DEFAULTS below.
//
// Each setting is validated by its own normaliser before it is stored, so the
// rest of the app can trust the shape it reads.

const prisma = require("../config/prisma");
const AppError = require("./AppError");

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const SETTINGS = {
  // The daily window in which no campaign message is sent. Until someone
  // saves it here, the server config (QUIET_HOURS_* in config.env, else
  // 21:00–09:00 Asia/Dubai) applies — see utils/quietHours.js.
  quietHours: {
    defaults: null,
    normalise(v) {
      if (!v || typeof v !== "object") throw new AppError("Quiet hours must be an object", 400);
      const enabled = v.enabled !== false;
      const start = String(v.start || "").trim();
      const end = String(v.end || "").trim();
      const timezone = String(v.timezone || "Asia/Dubai").trim();
      if (!HHMM.test(start) || !HHMM.test(end)) throw new AppError("Start and end must be times like 21:00", 400);
      if (start === end) throw new AppError("Start and end can't be the same time", 400);
      if (!isTimeZone(timezone)) throw new AppError(`Unknown time zone "${timezone}"`, 400);
      return { enabled, start, end, timezone };
    },
  },

  // Limits that protect the number's reputation with Meta.
  campaignSafety: {
    defaults: { frequencyCapDays: 0, qualityAutoPause: true, qualityPauseAt: "YELLOW" },
    normalise(v) {
      if (!v || typeof v !== "object") throw new AppError("Campaign safety must be an object", 400);
      // Required, so an empty save can't quietly reset the settings.
      if (v.frequencyCapDays === undefined || v.frequencyCapDays === null || v.frequencyCapDays === "") {
        throw new AppError("frequencyCapDays is required (0 = no limit)", 400);
      }
      const days = Number(v.frequencyCapDays);
      if (!Number.isInteger(days) || days < 0 || days > 90) {
        throw new AppError("The limit must be a whole number of days between 0 (off) and 90", 400);
      }
      const at = String(v.qualityPauseAt || "YELLOW").toUpperCase();
      if (!["YELLOW", "RED"].includes(at)) throw new AppError("Pause when quality is YELLOW or RED", 400);
      return { frequencyCapDays: days, qualityAutoPause: v.qualityAutoPause !== false, qualityPauseAt: at };
    },
  },
};

const cache = new Map();
let loadedAt = 0;
const REFRESH_MS = 60 * 1000;

async function loadSettings() {
  const rows = await prisma.appSetting.findMany();
  cache.clear();
  for (const r of rows) if (SETTINGS[r.key]) cache.set(r.key, r.value);
  loadedAt = Date.now();
}

// Kept fresh without blocking readers: a stale read is at most a minute old.
function refreshIfStale() {
  if (Date.now() - loadedAt < REFRESH_MS) return;
  loadedAt = Date.now();
  loadSettings().catch((err) => console.error("[Settings] refresh failed:", err.message));
}

// For the checks: values set in memory only, never saved, and the saved rows
// ignored (APP_SETTINGS_IGNORE_SAVED=1) so an admin's real settings can't
// change a check's outcome.
const testOverrides = new Map();
function overrideSettingForTest(key, value) {
  if (value === undefined) testOverrides.delete(key);
  else testOverrides.set(key, SETTINGS[key].normalise(value));
}

function getSetting(key) {
  if (!SETTINGS[key]) throw new Error(`Unknown setting ${key}`);
  const defaults0 = SETTINGS[key].defaults;
  if (testOverrides.has(key)) return defaults0 ? { ...defaults0, ...testOverrides.get(key) } : testOverrides.get(key);
  if (process.env.APP_SETTINGS_IGNORE_SAVED === "1") return defaults0 && { ...defaults0 };
  refreshIfStale();
  const saved = cache.get(key);
  const defaults = SETTINGS[key].defaults;
  if (saved === undefined) return defaults && { ...defaults };
  return defaults ? { ...defaults, ...saved } : saved;
}

async function saveSetting(key, value, user) {
  if (!SETTINGS[key]) throw new AppError(`Unknown setting "${key}"`, 400);
  const clean = SETTINGS[key].normalise(value);
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: clean, updatedById: user?.id ?? null },
    create: { key, value: clean, updatedById: user?.id ?? null },
  });
  cache.set(key, clean);
  return clean;
}

module.exports = { loadSettings, getSetting, saveSetting, overrideSettingForTest, SETTING_KEYS: Object.keys(SETTINGS) };
