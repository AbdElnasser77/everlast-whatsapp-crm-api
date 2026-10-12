// A scriptable stand-in for Meta's Graph API, for the campaign checks.
//
// install() swaps the axios module in require.cache BEFORE the app requires it,
// so the real whatsappClient (and the real send loop) run unchanged — only the
// HTTP call is fake. Every send is recorded, which is what lets a check count
// "did this phone get the campaign twice".
//
// Behaviour per phone, consumed one entry per send (the last entry repeats):
//   "ok"                      Meta accepts (after `delayMs`)
//   { ok: true, wamid }       Meta accepts and answers with this message id
//   { code: 131026 }          Meta answers with that error code
//   "timeout"                 axios timeout — the request may have reached Meta
//   "refused"                 ECONNREFUSED — the request never left
//   "hang"                    never answers (for crash tests)
//   "ok-then-die"             Meta accepts, then this process is SIGKILLed
//                             before the app can write anything down
// setOutage(step, ms) overrides every phone's step for a while (a Meta or
// network outage).
//
// Child processes are configured through env: FAKE_META_SCRIPT (JSON of the
// per-phone map), FAKE_META_DELAY_MS, and FAKE_META_LOG (a file each received
// send is appended to, one JSON line per send).

const fs = require("fs");
const path = require("path");

const calls = [];
const script = new Map();
let delayMs = Number(process.env.FAKE_META_DELAY_MS || 30);
let seq = 0;
let onSend = null;
let outage = null; // { step, until } or { step, callsLeft }
let tier = null; // messaging_limit_tier answered for GET /{phone-number-id}
const logFile = process.env.FAKE_META_LOG || null;

function setScript(map) {
  script.clear();
  for (const [phone, steps] of Object.entries(map || {})) script.set(phone, Array.isArray(steps) ? [...steps] : [steps]);
}
if (process.env.FAKE_META_SCRIPT) setScript(JSON.parse(process.env.FAKE_META_SCRIPT));

function nextStep(phone) {
  if (outage && outage.callsLeft !== undefined) {
    if (outage.callsLeft > 0) { outage.callsLeft--; return outage.step; }
  } else if (outage && Date.now() < outage.until) return outage.step;
  const steps = script.get(phone);
  if (!steps || steps.length === 0) return "ok";
  return steps.length > 1 ? steps.shift() : steps[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepName = (step) =>
  typeof step === "string" ? step : step && step.code !== undefined ? `meta:${step.code}` : step && step.ok ? "ok" : "unknown";

// Steps after which the person may have the message: Meta accepted it, or the
// request may have reached Meta before the answer was lost.
const MAYBE_DELIVERED = new Set(["ok", "ok-then-die", "hang", "timeout"]);

function metaError(code) {
  const err = new Error(`Request failed with status code 400`);
  err.response = { status: 400, data: { error: { code, message: `fake meta error ${code}`, error_user_title: `Fake ${code}` } } };
  err.isAxiosError = true;
  return err;
}

async function post(url, payload) {
  // Only message sends are scripted; anything else (typing indicators etc.)
  // just succeeds.
  if (!payload || payload.messaging_product !== "whatsapp" || !payload.to) {
    return { data: { success: true } };
  }
  const phone = String(payload.to);
  const step = nextStep(phone);
  const call = { phone, at: Date.now(), step: stepName(step), pid: process.pid, payload };
  calls.push(call);
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ ...call, payload: undefined }) + "\n");
  if (onSend) onSend(call);

  if (step === "hang") return new Promise(() => {});
  await sleep(delayMs);
  if (step === "ok") return { data: { messages: [{ id: `wamid.fake.${process.pid}.${++seq}` }] } };
  if (step && typeof step === "object" && step.ok) return { data: { messages: [{ id: step.wamid || `wamid.fake.${process.pid}.${++seq}` }] } };
  if (step === "ok-then-die") {
    setImmediate(() => process.kill(process.pid, "SIGKILL"));
    return { data: { messages: [{ id: `wamid.fake.${process.pid}.${++seq}` }] } };
  }
  if (step === "timeout") {
    const err = new Error("timeout of 30000ms exceeded");
    err.code = "ECONNABORTED";
    err.isAxiosError = true;
    throw err;
  }
  if (step === "refused") {
    const err = new Error("connect ECONNREFUSED 157.240.0.1:443");
    err.code = "ECONNREFUSED";
    err.isAxiosError = true;
    throw err;
  }
  if (step && typeof step === "object" && step.code !== undefined) throw metaError(step.code);
  throw new Error(`fakeMeta: unknown step ${JSON.stringify(step)}`);
}

// Number health / lookup answers: { quality_rating, status, display_phone_number }.
let numberInfo = { quality_rating: "GREEN", status: "CONNECTED", display_phone_number: "+971 50 000 0000", verified_name: "Check" };

async function get(url, config = {}) {
  const fields = (config.params && config.params.fields) || "";
  if (fields === "messaging_limit_tier") {
    if (!tier) throw metaError(100);
    return { data: { messaging_limit_tier: tier } };
  }
  if (fields.includes("quality_rating") || fields.includes("display_phone_number")) {
    if (!numberInfo) throw metaError(100);
    return { data: { ...numberInfo } };
  }
  throw new Error("fakeMeta: GET is not faked");
}

function install() {
  const axiosPath = require.resolve("axios", { paths: [path.join(__dirname, "..", "..")] });
  const fake = { post, get, create: () => fake, defaults: { headers: {} } };
  require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: fake };
}

// Every send recorded so far, in this process and (when logging) in children.
function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

module.exports = {
  install,
  calls,
  setScript,
  MAYBE_DELIVERED,
  setDelay: (ms) => { delayMs = ms; },
  onSend: (fn) => { onSend = fn; },
  setOutage: (step, ms) => { outage = { step, until: Date.now() + ms }; },
  // The next `calls` sends (to anyone) get `step` — independent of timing.
  failNext: (step, calls) => { outage = { step, callsLeft: calls }; },
  setTier: (t) => { tier = t; },
  // null = Meta rejects the lookup (bad id / token).
  setNumberInfo: (info) => { numberInfo = info; },
  reset: () => { calls.length = 0; script.clear(); onSend = null; outage = null; },
  readLog,
};
