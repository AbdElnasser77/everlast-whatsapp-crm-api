// "Is the clinic free then?" — read from the clinic system (Dok32), never
// written. Used by the booking flow so patients only pick days and times the
// clinic can actually take; an agent still books it in Dok32 by hand.
//
// How Dok32 holds a schedule (studied on the live data):
//   - The real shifts are BLOCKED time around them: "11:00 am till 9:00 pm"
//     is saved as blocks 07:00–11:00 and 21:00–23:59 on that person; a day
//     off is one block over the whole day ("closed"). Working-hours tables are
//     placeholders (07:00–23:59 every day) and are ignored.
//   - A person with no block row on a day has no schedule entered yet — that
//     is "unknown", never "free".
//   - Doctors see patients in parallel calendar columns; therapists one at a
//     time. Capacity = how many columns the person really uses.
//   - Cancelled / no-show bookings are moved to a parking column ("Public
//     Point") with a freed status — they don't take time.
//
// Simple on purpose: a time is offered when at least one person working then
// has room for a visit of VISIT_MINUTES. Which person does the treatment is
// the agent's call when they book it.
//
// Dates are clinic-local "YYYY-MM-DD", times "HH:MM" (Asia/Dubai, UTC+4, no
// daylight saving).

const dok32 = require("./dok32");

const CLINIC_ID = 2; // "Everlast … - Branch" — the clinic all bookings are in
const TZ_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

const SLOT_STEP_MINUTES = 30; // offered start times: :00 and :30
const VISIT_MINUTES = 60; // room needed for a time to be offered
const MIN_LEAD_MINUTES = 120; // no times starting within the next 2 hours
const HORIZON_DAYS = 30; // how far ahead patients can pick
const DAY_FROM = 7 * 60 * MIN; // Dok32's day: 07:00–23:59 local
const DAY_TO = 24 * 60 * MIN - MIN;
// Visits end by 22:00 (real bookings end around 21:00–22:00). Some evening
// shifts have no closing block in Dok32, which would otherwise offer 23:00.
const LAST_END = 22 * 60 * MIN;

// Statuses that free the time (cancelled, missed, rescheduled, …).
const FREED_STATUSES = [72, 73, 74, 75, 37, 56, 778, 779, 780, 797, 798, 799, 801];
const PARKING_MEMBER = 386; // "Public Point" — where cancelled bookings are parked
const PARKING_POINT = 179; // "Prescription Only"
const BREAK_CATEGORY = 562; // breaks are booked as appointments; they still take time

const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const CLOSED_WEEKDAYS = ["SATURDAY"];

// ── dates ───────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");
const isDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
/** Clinic-local date of an instant. */
const localDay = (date = new Date()) => new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** The instant local midnight of `day` happens. */
const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`) - TZ_OFFSET_MS;
const weekdayOf = (day) => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const hhmm = (ms) => `${pad(Math.floor(ms / (60 * MIN)))}:${pad(Math.floor((ms % (60 * MIN)) / MIN))}`;

/** "Tue 21 Oct" */
function labelFor(day) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

/** "4:30 PM" */
function timeLabel(time) {
  const [h, m] = time.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

// ── reading Dok32 ───────────────────────────────────────────────────────────

// Who takes appointments, and in how many columns at once. Changes slowly —
// cached for an hour.
let peopleCache = null;
async function bookablePeople() {
  if (peopleCache && peopleCache.until > Date.now()) return peopleCache.people;
  const since = Date.now() - 60 * DAY_MS;
  const rows = await dok32.query(
    `SELECT a.dentistid AS id,
            bool_or(coalesce(m.allowappointmentoverlap, false)) AS overlap,
            count(*) AS visits,
            count(DISTINCT a.dentalpointid) AS points
       FROM {schema}.clinic_patient_appointment a
       JOIN {schema}.member m ON m.id = a.dentistid
      WHERE NOT a.deleted AND a.clinicid = $1 AND a.date >= $2
        AND a.dentistid <> $3 AND coalesce(a.dentalpointid, 0) <> $4
        AND coalesce(a.categoryid, 0) <> $5
      GROUP BY a.dentistid
     HAVING count(*) >= 20`,
    [CLINIC_ID, since, PARKING_MEMBER, PARKING_POINT, BREAK_CATEGORY],
  );
  // Columns a person really works in (not the odd one-off).
  const usedPoints = await dok32.query(
    `SELECT dentistid AS id, count(*) AS points FROM (
       SELECT dentistid, dentalpointid
         FROM {schema}.clinic_patient_appointment
        WHERE NOT deleted AND clinicid = $1 AND date >= $2 AND dentistid <> $3 AND coalesce(dentalpointid, 0) <> $4
        GROUP BY 1, 2 HAVING count(*) >= 10) x
      GROUP BY 1`,
    [CLINIC_ID, since, PARKING_MEMBER, PARKING_POINT],
  );
  const pointsOf = new Map(usedPoints.map((r) => [Number(r.id), Number(r.points)]));
  const people = rows.map((r) => ({
    id: Number(r.id),
    capacity: r.overlap ? Math.max(1, pointsOf.get(Number(r.id)) || 1) : 1,
  }));
  peopleCache = { people, until: Date.now() + 60 * 60 * 1000 };
  return people;
}

async function readRange(from, to, ids) {
  const blocks = await dok32.query(
    `SELECT bm.memberid AS member, b.recurrencetypecode AS rec, b.weekdays AS weekdays,
            b.startdate::date::text AS start_day, b.enddate::date::text AS end_day,
            b.starttime AS from_ms, b.endtime AS to_ms,
            coalesce(b.excludeddates, '') AS excluded, coalesce(b.repeatcount, 1) AS every
       FROM {schema}.clinic_blocked_time_slot b
       JOIN {schema}.clinic_blocked_time_slot_member bm ON bm.clinicblockedtimeslotid = b.id
      WHERE NOT b.deleted AND bm.memberid = ANY($1::bigint[])
        AND b.enddate >= $2::date AND b.startdate < ($3::date + 1)`,
    [ids, from, to],
  );
  const visits = await dok32.query(
    `SELECT dentistid AS member, starttime AS start_ms, coalesce(endtime, starttime + duration) AS end_ms
       FROM {schema}.clinic_patient_appointment
      WHERE NOT deleted AND dentistid = ANY($1::bigint[])
        AND coalesce(statusid, 0) <> ALL($2::bigint[])
        AND coalesce(dentalpointid, 0) <> $3
        AND starttime < $5 AND coalesce(endtime, starttime + duration) > $4`,
    [ids, FREED_STATUSES, PARKING_POINT, dayStartMs(from), dayStartMs(addDays(to, 1))],
  );
  return {
    blocks: blocks.map((b) => ({ ...b, member: Number(b.member), from_ms: Number(b.from_ms), to_ms: Number(b.to_ms), every: Math.max(1, Number(b.every) || 1) })),
    visits: visits.map((v) => ({ member: Number(v.member), start: Number(v.start_ms), end: Number(v.end_ms) })),
  };
}

/** Does this (possibly repeating) block apply on `day`? */
function blockOn(block, day) {
  if (day < block.start_day || day > block.end_day) return false;
  if (block.excluded.includes(day)) return false;
  if (block.rec === "WEEKLY") return String(block.weekdays || "").toUpperCase().split("|").includes(weekdayOf(day));
  if (block.rec === "DAILY") return daysBetween(block.start_day, day) % block.every === 0;
  return true; // a one-off block covering its date range
}

/** [from, to) local-ms windows left after removing `blocked` from Dok32's day. */
function freeWindows(blocked) {
  const sorted = blocked.map((b) => [Math.max(DAY_FROM, b.from_ms), Math.min(DAY_TO, b.to_ms)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const windows = [];
  let cursor = DAY_FROM;
  for (const [a, b] of sorted) {
    if (a > cursor) windows.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < DAY_TO) windows.push([cursor, DAY_TO]);
  return windows;
}

// ── the day ─────────────────────────────────────────────────────────────────

function evaluateDay(day, people, { blocks, visits }, now) {
  const base = { date: day, label: labelFor(day), slots: [] };
  const today = localDay(now);
  if (day < today) return { ...base, status: "PAST" };
  if (daysBetween(today, day) > HORIZON_DAYS) return { ...base, status: "TOO_FAR" };
  if (CLOSED_WEEKDAYS.includes(weekdayOf(day))) return { ...base, status: "CLOSED" };

  const start = dayStartMs(day);
  const working = [];
  let scheduled = 0;
  for (const person of people) {
    const mine = blocks.filter((b) => b.member === person.id && blockOn(b, day));
    if (mine.length === 0) continue; // no schedule entered for that day
    scheduled++;
    const windows = freeWindows(mine).filter(([a, b]) => b - a >= VISIT_MINUTES * MIN);
    if (windows.length === 0) continue; // day off
    working.push({
      ...person,
      windows,
      visits: visits.filter((v) => v.member === person.id && v.end > start && v.start < start + DAY_MS),
    });
  }
  if (scheduled === 0) return { ...base, status: "NOT_SCHEDULED" };
  if (working.length === 0) return { ...base, status: "CLOSED" };

  const earliest = now.getTime() + MIN_LEAD_MINUTES * MIN;
  const visit = VISIT_MINUTES * MIN;
  for (let t = DAY_FROM; t + visit <= LAST_END; t += SLOT_STEP_MINUTES * MIN) {
    const at = start + t;
    if (at < earliest) continue;
    const free = working.some(
      (p) =>
        p.windows.some(([a, b]) => t >= a && t + visit <= b + MIN) &&
        p.visits.filter((v) => v.start < at + visit && v.end > at).length < p.capacity,
    );
    if (free) base.slots.push(hhmm(t));
  }
  return { ...base, status: base.slots.length ? "OPEN" : "FULL" };
}

async function evaluateRange(from, to, now = new Date()) {
  const people = await bookablePeople();
  const data = await readRange(from, to, people.map((p) => p.id));
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(evaluateDay(d, people, data, now));
  return days;
}

// Patients tapping through a flow ask for the same days again and again: a
// short cache keeps that to one Dok32 read a minute. The final check before a
// time is accepted (isSlotFree) always reads fresh.
const rangeCache = new Map();
const CACHE_MS = 60 * 1000;
async function cachedRange(from, to) {
  const key = `${from}|${to}`;
  const hit = rangeCache.get(key);
  if (hit && hit.until > Date.now()) return hit.days;
  const days = await evaluateRange(from, to);
  rangeCache.set(key, { days, until: Date.now() + CACHE_MS });
  if (rangeCache.size > 50) rangeCache.delete(rangeCache.keys().next().value);
  return days;
}

// ── public ──────────────────────────────────────────────────────────────────

const isConfigured = () => dok32.isConfigured();

/** One day: { date, label, status, slots }. */
async function getDay(date) {
  if (!isDay(date)) throw new Error("Invalid date");
  const today = localDay();
  if (date < today || daysBetween(today, date) > HORIZON_DAYS) return evaluateDay(date, [], { blocks: [], visits: [] }, new Date());
  const [day] = await cachedRange(date, date);
  return day;
}

/** The next open days, soonest first. */
async function nearestOpenDays({ from, count = 10 } = {}) {
  const today = localDay();
  const start = from && isDay(from) && from > today ? from : today;
  const end = addDays(today, HORIZON_DAYS);
  if (start > end) return [];
  const days = await cachedRange(start, end);
  return days.filter((d) => d.status === "OPEN").slice(0, count);
}

/** Fresh check of one time, right before it's accepted. */
async function isSlotFree(date, time) {
  if (!isDay(date) || !/^\d{2}:\d{2}$/.test(String(time))) return false;
  const [day] = await evaluateRange(date, date);
  return day.status === "OPEN" && day.slots.includes(time);
}

/** A patient-facing sentence for a day that can't be booked. */
function describeStatus(day) {
  switch (day.status) {
    case "PAST":
      return "That date has already passed.";
    case "TOO_FAR":
      return `We can only take bookings up to ${HORIZON_DAYS} days ahead.`;
    case "CLOSED":
      return `Sorry, we're closed on ${day.label}.`;
    case "NOT_SCHEDULED":
      return `Sorry, the schedule for ${day.label} isn't open yet.`;
    case "FULL":
      return day.date === localDay() ? "Sorry, there are no more free times today." : `Sorry, ${day.label} is fully booked.`;
    default:
      return "";
  }
}

// ── understanding what patients type ────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthIndex = (word) => MONTHS.indexOf(String(word).slice(0, 3).toLowerCase());

/** A date from what a patient typed, or null. Day-first (as in the UAE). */
function parsePatientDate(text, now = new Date()) {
  const raw = String(text || "").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ");
  if (!raw) return null;
  const today = localDay(now);
  if (/\b(today|tonight)\b|اليوم/.test(raw)) return today;
  if (/\b(tomorrow|tmrw|tmr)\b|بكر[هة]|غدا|غداً/.test(raw)) return addDays(today, 1);

  const make = (y, m, d) => {
    const s = `${y}-${pad(m)}-${pad(d)}`;
    return isDay(s) && new Date(`${s}T00:00:00Z`).getUTCDate() === d ? s : null;
  };
  // No year given: the next time that date comes round.
  const upcoming = (m, d) => {
    const year = Number(today.slice(0, 4));
    const s = make(year, m, d);
    if (!s) return null;
    return s >= today ? s : make(year + 1, m, d);
  };

  let m;
  if ((m = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return make(+m[1], +m[2], +m[3]);
  if ((m = raw.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return y ? make(y, +m[2], +m[1]) : upcoming(+m[2], +m[1]);
  }
  if ((m = raw.match(/\b(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?\b/)) && monthIndex(m[2]) >= 0) {
    return m[3] ? make(+m[3], monthIndex(m[2]) + 1, +m[1]) : upcoming(monthIndex(m[2]) + 1, +m[1]);
  }
  if ((m = raw.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?\b/)) && monthIndex(m[1]) >= 0) {
    return m[3] ? make(+m[3], monthIndex(m[1]) + 1, +m[2]) : upcoming(monthIndex(m[1]) + 1, +m[2]);
  }
  // A weekday: the next one (today counts). "next monday" skips this week's.
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w.slice(0, 3).toLowerCase()}`).test(raw));
  if (wd >= 0) {
    const todayIdx = new Date(`${today}T00:00:00Z`).getUTCDay();
    let ahead = (wd - todayIdx + 7) % 7;
    if (/\bnext\b/.test(raw) && ahead === 0) ahead = 7;
    return addDays(today, ahead);
  }
  return null;
}

/** A time from what a patient typed ("4:30 pm", "16:30", "4pm"), or null. */
function parsePatientTime(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return null;
  if (/\bnoon\b/.test(raw)) return "12:00";
  const m = raw.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ص|م)?/);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (h > 23 || min > 59) return null;
  const mer = m[3] || "";
  if (/^(pm|p\.m\.|م)$/.test(mer) && h < 12) h += 12;
  else if (/^(am|a\.m\.|ص)$/.test(mer) && h === 12) h = 0;
  else if (!mer && h >= 1 && h <= 7) h += 12; // "4" at a clinic means 4 PM
  return `${pad(h)}:${pad(min)}`;
}

module.exports = {
  isConfigured,
  getDay,
  nearestOpenDays,
  isSlotFree,
  describeStatus,
  parsePatientDate,
  parsePatientTime,
  labelFor,
  timeLabel,
  // for checks
  _internal: { evaluateDay, freeWindows, blockOn, localDay, addDays },
};
