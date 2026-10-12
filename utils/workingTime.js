// Working time = the hours the clinic answers chats: everything outside the
// quiet-hours window (Settings → Quiet hours; 21:00–09:00 Dubai by default).
//
// "Waiting 45 minutes" for a message that arrived at 20:50 and was answered at
// 09:05 the next morning is 25 minutes of working time, not 12 hours — a
// patient who writes at night is not a missed follow-up until the team is in.
// With quiet hours turned off, every minute counts.

const { getQuietHoursConfig, isQuietHours, nextSendWindowOpen, localMinuteOfDay } = require("./quietHours");

const MIN = 60 * 1000;

// The next moment quiet hours begin, at or after `date` (minute precision).
function nextQuietStart(date, config) {
  const m = localMinuteOfDay(date, config.timezone);
  const minutesUntil = (config.startMin - m + 1440) % 1440 || 1440;
  const startOfMinute = Math.floor(date.getTime() / MIN) * MIN;
  return new Date(startOfMinute + minutesUntil * MIN);
}

// Milliseconds of working time between two moments.
function workingMsBetween(from, to = new Date(), config = getQuietHoursConfig()) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  if (!(end > start)) return 0;
  if (!config.enabled) return end - start;
  let t = start;
  let total = 0;
  // Each step jumps a whole working or quiet stretch, so this is a handful of
  // iterations per day waited, not one per minute.
  for (let guard = 0; t < end && guard < 400; guard++) {
    const at = new Date(t);
    if (isQuietHours(at, config)) {
      t = Math.max(t + MIN, nextSendWindowOpen(at, config).getTime());
      continue;
    }
    const stop = Math.min(end, nextQuietStart(at, config).getTime());
    total += stop - t;
    t = stop;
  }
  return total;
}

const workingMinutesBetween = (from, to, config) => Math.floor(workingMsBetween(from, to, config) / MIN);

module.exports = { workingMsBetween, workingMinutesBetween };
