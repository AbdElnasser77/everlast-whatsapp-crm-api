const AppError = require("../../utils/AppError");

// Free appointment times in the clinic system (Dok32), read-only — for the
// flow builder's test run and the booking request cards ("still free?").
// Nothing here books anything. Dates are clinic-local YYYY-MM-DD, times HH:MM.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

// Loaded on use: the module needs Dok32 settings, and the API must start (and
// every other route work) without them. Any failure → 503 DOK32_UNAVAILABLE.
async function clinic(fn, ...args) {
  let mod;
  try {
    mod = require("../../utils/clinicAvailability");
  } catch (err) {
    console.warn("[availability] module not loaded:", err.message);
    throw new AppError("The clinic system isn't connected", 503, "DOK32_UNAVAILABLE");
  }
  if (!mod.isConfigured()) throw new AppError("The clinic system isn't connected", 503, "DOK32_UNAVAILABLE");
  try {
    return await mod[fn](...args);
  } catch (err) {
    console.warn(`[availability] ${fn} failed:`, err.message);
    throw new AppError("The clinic system isn't reachable right now", 503, "DOK32_UNAVAILABLE");
  }
}

const requireDate = (v) => {
  if (!DATE_RE.test(String(v || ""))) throw new AppError("date must be YYYY-MM-DD", 400);
  return String(v);
};

// ─── GET /api/availability/days?count=10 ─────────────────────────────────────
// The nearest open days, soonest first (may be fewer than count, or none).
const getDays = async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.query.count) || 10, 1), 30);
  const days = await clinic("nearestOpenDays", { count });
  res.json({ success: true, data: days });
};

// ─── GET /api/availability/day?date=YYYY-MM-DD ───────────────────────────────
// One day: { date, status, slots, label }, plus `message` — what the patient
// is told about a day that isn't open ("Sorry, we're closed on Sat 18 Oct.").
const getDay = async (req, res) => {
  const day = await clinic("getDay", requireDate(req.query.date));
  const message = day.status === "OPEN" ? null : await clinic("describeStatus", day);
  res.json({ success: true, data: { ...day, message } });
};

// ─── GET /api/availability/check?date=YYYY-MM-DD&time=HH:MM ──────────────────
const checkSlot = async (req, res) => {
  const date = requireDate(req.query.date);
  const time = String(req.query.time || "");
  if (!TIME_RE.test(time)) throw new AppError("time must be HH:MM", 400);
  const free = await clinic("isSlotFree", date, time);
  res.json({ success: true, data: { date, time, free: Boolean(free) } });
};

// ─── GET /api/availability/parse?text=… ──────────────────────────────────────
// How the flow reads a typed answer: { date, time } (either may be null). Lets
// the flow builder's test run behave exactly like the real thing.
const parseText = async (req, res) => {
  const text = String(req.query.text || "").slice(0, 200);
  const [date, time] = await Promise.all([clinic("parsePatientDate", text), clinic("parsePatientTime", text)]);
  res.json({ success: true, data: { date: date || null, time: time || null } });
};

module.exports = { getDays, getDay, checkSlot, parseText };
