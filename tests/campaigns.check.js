// Campaign send-safety check: every person gets a campaign AT MOST ONCE, the
// send stops when told, and it survives crashes, restarts and two instances.
//
// Drives the REAL send loop (processCampaign) and the REAL HTTP handlers, with
// only Meta faked (tests/support/fakeMeta.js) so every send can be counted.
// Crash and two-instance scenarios run the loop in child processes
// (tests/campaigns.child.js) and kill them.
//
// Safe to run against a database with real patients: it creates only its own
// tagged rows — a throwaway WhatsApp number, phones starting TAG, a user named
// cc_admin — records every id it creates, and deletes exactly those in a
// finally block.
//
//   npm run check:campaigns              all sections
//   npm run check:campaigns -- stop      only sections whose name contains "stop"

// Quiet hours off (start == end disables them) and a short lease, so crash
// recovery can be exercised in seconds. Set before anything reads config.env;
// dotenv never overrides a variable that is already set. Children inherit these.
process.env.QUIET_HOURS_START = "00:00";
process.env.QUIET_HOURS_END = "00:00";
process.env.QUIET_HOURS_FORCE_ENV = "1";
process.env.APP_SETTINGS_IGNORE_SAVED = "1";
process.env.CAMPAIGN_LEASE_MS = "10000";
process.env.CAMPAIGN_HEARTBEAT_MS = "1000";
process.env.WHATSAPP_TOKEN_CAMPAIGNCHECK = "fake-token";
// Error handling on a short clock: retries, auto-resume and per-person
// requeue in milliseconds; small pages so paging is exercised.
process.env.CAMPAIGN_RETRY_DELAYS_MS = "50,100,150";
process.env.CAMPAIGN_REQUEUE_DELAY_MS = "1500";
process.env.CAMPAIGN_RATE_LIMIT_RESUME_MS = "1500";
process.env.CAMPAIGN_CONNECTION_RESUME_MS = "1500";
process.env.CAMPAIGN_RECIPIENT_PAGE = "7";
process.env.WEBHOOK_STATUS_RETRY_MS = "300,1000";

const fakeMeta = require("./support/fakeMeta");
fakeMeta.install();
require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const campaigns = require("../modules/campaigns/campaign.controller");
const customersCtl = require("../modules/customers/customer.controller");
const scheduler = require("../jobs/campaignScheduler");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m";
const TAG = "999556";
const PNID = "__campaign_check_pnid__";
const LEASE_MS = Number(process.env.CAMPAIGN_LEASE_MS);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = { numbers: [], customers: [], users: [], templates: [], campaigns: [] };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "campaign-check-"));
let ctx; // { admin, number, template }
let phoneSeq = 0;

// ── helpers ─────────────────────────────────────────────────────────────────

// Calls an Express handler and resolves with what it answered.
function callHandler(handler, req) {
  return new Promise((resolve) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(body) { resolve({ code: this.code, body }); },
    };
    Promise.resolve(handler(req, res, (err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
  });
}
const reqFor = (id, extra = {}) => ({
  params: { id: String(id) },
  numberId: ctx.number.id,
  number: ctx.number,
  user: ctx.admin,
  body: {},
  ...extra,
});

// A campaign on the throwaway number with `n` fresh customers, already RUNNING
// (what send-now / approve / the scheduler leave behind before the loop starts).
async function makeCampaign(n, { status = "RUNNING", names, templateId, createdById } = {}) {
  const customers = [];
  for (let i = 0; i < n; i++) {
    const phone = `${TAG}${String(++phoneSeq).padStart(5, "0")}`;
    const c = await prisma.customer.create({ data: { name: names?.[i] ?? `CC Person ${phoneSeq}`, phone } });
    made.customers.push(c.id);
    customers.push(c);
  }
  const campaign = await prisma.campaign.create({
    data: {
      name: `CC campaign ${made.campaigns.length + 1}`,
      templateId: templateId || ctx.template.id,
      whatsappNumberId: ctx.number.id,
      createdById: createdById || ctx.admin.id,
      status,
      startedAt: status === "RUNNING" ? new Date() : null,
      totalRecipients: n,
      recipients: { create: customers.map((c) => ({ customerId: c.id })) },
    },
  });
  made.campaigns.push(campaign.id);
  return { campaign, customers, phones: customers.map((c) => c.phone) };
}

// Every send Meta received for these phones: this process plus any child logs.
function sendsByPhone(phones, logFiles = []) {
  const all = [...fakeMeta.calls, ...logFiles.flatMap((f) => fakeMeta.readLog(f))];
  const counts = new Map(phones.map((p) => [p, 0]));
  // Only sends Meta could have delivered: a refused request isn't a message.
  for (const c of all) if (counts.has(c.phone) && fakeMeta.MAYBE_DELIVERED.has(c.step)) counts.set(c.phone, counts.get(c.phone) + 1);
  return counts;
}
function exactlyOnce(counts) {
  const bad = [...counts].filter(([, n]) => n !== 1);
  return { ok: bad.length === 0, detail: bad.length ? `wrong: ${bad.map(([p, n]) => `${p.slice(-3)}×${n}`).join(", ")}` : `${counts.size} phones × 1` };
}
// After a crash the rule is AT MOST once: a send that may have reached Meta is
// never repeated. Anyone who got nothing must say so ("Not confirmed").
async function atMostOnce(campaignId, counts) {
  const rows = await recipientsOf(campaignId);
  const twice = [...counts].filter(([, n]) => n > 1);
  const silent = rows.filter((r) => counts.get(r.customer.phone) === 0 && !(r.status === "FAILED" && /not confirmed/i.test(r.error || "")));
  const unconfirmed = rows.filter((r) => /not confirmed/i.test(r.error || "")).length;
  return {
    twice, silent, unconfirmed,
    detail: `${twice.length} twice, ${silent.length} missed without a reason, ${unconfirmed} not confirmed`,
  };
}
const getCampaign = (id) => prisma.campaign.findUnique({ where: { id } });
const recipientsOf = (id) => prisma.campaignRecipient.findMany({ where: { campaignId: id }, include: { customer: true }, orderBy: { id: "asc" } });

async function waitFor(fn, timeoutMs = 30_000, everyMs = 250) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}
const waitStatus = (id, statuses, timeoutMs) =>
  waitFor(async () => { const c = await getCampaign(id); return c && statuses.includes(c.status) ? c : null; }, timeoutMs);

// Resolves with "resolved" / "rejected: …" / "timeout" — so a stuck or
// crashing send loop is a FAIL line, not a hung check.
function settle(promise, timeoutMs = 60_000) {
  return Promise.race([
    promise.then(() => "resolved", (err) => `rejected: ${err && err.message}`),
    sleep(timeoutMs).then(() => "timeout"),
  ]);
}

function spawnChild(campaignId, { script = {}, delayMs = 30 } = {}) {
  const log = path.join(tmpDir, `child-${campaignId}-${Math.random().toString(36).slice(2)}.log`);
  const child = spawn(process.execPath, [path.join(__dirname, "campaigns.child.js"), String(campaignId)], {
    env: { ...process.env, FAKE_META_LOG: log, FAKE_META_SCRIPT: JSON.stringify(script), FAKE_META_DELAY_MS: String(delayMs) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, log, exited };
}

// What a restarted server does with campaigns a dead process left RUNNING.
// Scoped to this check's campaign so real campaigns are never touched.
async function recover(campaignId) {
  if (typeof scheduler.recoverInterruptedCampaigns === "function") {
    // Like the server's minute sweep, but every 2s: keep trying until the dead
    // process's lease has expired and recovery has taken the campaign.
    for (let i = 0; i < 15; i++) {
      await scheduler.recoverInterruptedCampaigns({ campaignIds: [campaignId] });
      await sleep(2000);
      const c = await getCampaign(campaignId);
      if (!c || c.status !== "RUNNING" || c.lockedBy) return;
    }
  } else {
    // Today's startup recovery: processCampaign for every RUNNING campaign.
    await campaigns.processCampaign(campaignId);
  }
}

// ── sections ────────────────────────────────────────────────────────────────

const sections = [];
const section = (name, fn) => sections.push({ name, fn });

section("stop: cancel right after the send starts", async () => {
  for (const delay of [0, 150, 400, 800]) {
    fakeMeta.reset();
    const { campaign, phones } = await makeCampaign(20);
    const loop = campaigns.processCampaign(campaign.id);
    await sleep(delay);
    const r = await callHandler(campaigns.cancelCampaign, reqFor(campaign.id));
    const cancelledAt = Date.now();
    const outcome = await settle(loop);
    const after = fakeMeta.calls.filter((c) => phones.includes(c.phone) && c.at > cancelledAt).length;
    const c = await getCampaign(campaign.id);
    check(`cancel ${delay}ms after start: no sends after Cancel returned`, after === 0 && !r.error,
      `${after} sends after cancel, ${fakeMeta.calls.length} total, loop ${outcome}`);
    check(`cancel ${delay}ms after start: campaign stays CANCELLED`, c.status === "CANCELLED", `→ ${c.status}`);
  }
});

section("stop: pause right after the send starts, then resume", async () => {
  for (const delay of [0, 300]) {
    fakeMeta.reset();
    const { campaign, phones } = await makeCampaign(15);
    const loop = campaigns.processCampaign(campaign.id);
    await sleep(delay);
    await callHandler(campaigns.pauseCampaign, reqFor(campaign.id));
    const pausedAt = Date.now();
    await settle(loop);
    const after = fakeMeta.calls.filter((c) => c.at > pausedAt).length;
    const c = await getCampaign(campaign.id);
    check(`pause ${delay}ms after start: no sends after Pause returned`, after === 0, `${after} sends after pause`);
    check(`pause ${delay}ms after start: campaign is PAUSED`, c.status === "PAUSED", `→ ${c.status}`);

    await callHandler(campaigns.resumeCampaign, reqFor(campaign.id));
    const done = await waitStatus(campaign.id, ["COMPLETED"], 40_000);
    const once = exactlyOnce(sendsByPhone(phones));
    check(`pause ${delay}ms → resume: completes, everyone exactly once`, done && once.ok, `${done ? "COMPLETED" : "not completed"}; ${once.detail}`);
  }
});

section("stop: rapid pause/resume/pause/resume", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(20);
  campaigns.processCampaign(campaign.id).catch(() => {});
  await sleep(300);
  for (const h of [campaigns.pauseCampaign, campaigns.resumeCampaign, campaigns.pauseCampaign, campaigns.resumeCampaign]) {
    await callHandler(h, reqFor(campaign.id));
    await sleep(60);
  }
  const done = await waitStatus(campaign.id, ["COMPLETED"], 60_000);
  const once = exactlyOnce(sendsByPhone(phones));
  const rs = await recipientsOf(campaign.id);
  check("rapid pause/resume: completes", Boolean(done), done ? "" : `→ ${(await getCampaign(campaign.id)).status}`);
  check("rapid pause/resume: everyone exactly once", once.ok, once.detail);
  check("rapid pause/resume: every recipient SENT", rs.every((r) => r.status === "SENT"), rs.map((r) => r.status[0]).join(""));
});

section("crash: process killed while Meta has not answered", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(10);
  const hung = phones[3];
  const run = spawnChild(campaign.id, { script: { [hung]: "hang" } });
  await waitFor(() => fakeMeta.readLog(run.log).some((c) => c.phone === hung), 30_000, 100);
  await sleep(400);
  run.child.kill("SIGKILL");
  await run.exited;
  await sleep(LEASE_MS + 500);
  await recover(campaign.id);
  const c = await waitStatus(campaign.id, ["COMPLETED", "PAUSED", "CANCELLED"], 40_000);
  const amo = await atMostOnce(campaign.id, sendsByPhone(phones, [run.log]));
  const rs = await recipientsOf(campaign.id);
  const hungRow = rs.find((r) => r.customer.phone === hung);
  check("crash mid-send: nobody received it twice", amo.twice.length === 0, amo.detail);
  check("crash mid-send: everyone not sent is marked 'Not confirmed'", amo.silent.length === 0, amo.detail);
  check("crash mid-send: only sends in flight at the crash are unconfirmed (≤ 5 lanes)", amo.unconfirmed <= 5, amo.detail);
  check("crash mid-send: the unanswered send is FAILED 'Not confirmed', not resent",
    hungRow.status === "FAILED" && /not confirmed/i.test(hungRow.error || ""), `→ ${hungRow.status} ${hungRow.error || ""}`);
  check("crash mid-send: campaign completes after recovery", c && c.status === "COMPLETED", `→ ${c && c.status} ${c && c.pauseReason || ""} ${c && c.pauseDetail || ""}`);
  check("crash mid-send: nobody left PENDING/SENDING", rs.every((r) => !["PENDING", "SENDING"].includes(r.status)), rs.map((r) => r.status[0]).join(""));
});

section("crash: process killed after Meta accepted, before the database write", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(10);
  const run = spawnChild(campaign.id, { script: { [phones[2]]: "ok-then-die" } });
  await run.exited;
  await sleep(LEASE_MS + 500);
  await recover(campaign.id);
  const c = await waitStatus(campaign.id, ["COMPLETED", "PAUSED", "CANCELLED"], 40_000);
  const amo = await atMostOnce(campaign.id, sendsByPhone(phones, [run.log]));
  check("crash after Meta accepted: nobody received it twice", amo.twice.length === 0, amo.detail);
  check("crash after Meta accepted: everyone not sent is marked 'Not confirmed'", amo.silent.length === 0, amo.detail);
  const rs2 = await recipientsOf(campaign.id);
  check("crash after Meta accepted: nobody left PENDING/SENDING", rs2.every((r) => !["PENDING", "SENDING"].includes(r.status)), rs2.map((r) => r.status[0]).join(""));
  check("crash after Meta accepted: campaign completes after recovery", c && c.status === "COMPLETED", `→ ${c && c.status}`);
});

section("instances: two server processes start the same campaign", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(20);
  const a = spawnChild(campaign.id);
  const b = spawnChild(campaign.id);
  const [ea, eb] = await Promise.all([a.exited, b.exited]);
  const once = exactlyOnce(sendsByPhone(phones, [a.log, b.log]));
  const c = await getCampaign(campaign.id);
  check("two instances: everyone exactly once", once.ok, once.detail);
  check("two instances: campaign COMPLETED", c.status === "COMPLETED", `→ ${c.status}; exits ${ea.code}/${eb.code}`);
});

section("delete: a customer is deleted while the campaign sends", async () => {
  fakeMeta.reset();
  fakeMeta.setDelay(300);
  const { campaign, customers } = await makeCampaign(12);
  const victim = customers[customers.length - 1];
  let deleted = null;
  fakeMeta.onSend(() => {
    if (!deleted) deleted = callHandler(customersCtl.deleteCustomer, { params: { id: String(victim.id) } });
  });
  const outcome = await settle(campaigns.processCampaign(campaign.id));
  const del = await deleted;
  fakeMeta.setDelay(30);
  const c = await getCampaign(campaign.id);
  check("customer deleted mid-send: the delete succeeded", del && !del.error, del && del.error ? del.error.message : "");
  check("customer deleted mid-send: send loop finishes cleanly", outcome === "resolved", outcome);
  check("customer deleted mid-send: campaign COMPLETED, not stuck RUNNING", c.status === "COMPLETED", `→ ${c.status}`);
});

section("delete: a just-cancelled campaign is deleted while sends drain", async () => {
  fakeMeta.reset();
  fakeMeta.setDelay(300);
  const { campaign } = await makeCampaign(10);
  let ops = null;
  fakeMeta.onSend(() => {
    if (ops) return;
    ops = (async () => {
      const cancel = await callHandler(campaigns.cancelCampaign, reqFor(campaign.id));
      const del = await callHandler(campaigns.deleteCampaign, reqFor(campaign.id));
      return { cancel, del };
    })();
  });
  const outcome = await settle(campaigns.processCampaign(campaign.id));
  const { del } = await ops;
  fakeMeta.setDelay(30);
  // A campaign that already sent is hidden (deletedAt) so its history stays;
  // one that never sent is removed outright.
  const row = await getCampaign(campaign.id);
  const gone = !row || row.deletedAt !== null;
  check("deleted while draining: delete succeeded", !del.error && gone, del.error ? del.error.message : row ? "still visible" : "");
  check("deleted while draining: send loop finishes cleanly", outcome === "resolved", outcome);
});

section("data: the same customer cannot be in one campaign twice", async () => {
  const { campaign, customers } = await makeCampaign(1, { status: "DRAFT" });
  let err = null;
  try {
    await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, customerId: customers[0].id } });
  } catch (e) { err = e; }
  check("duplicate recipient is rejected by the database", err && err.code === "P2002", err ? err.code : "inserted a duplicate");
});

// ── Phase 2–5: errors, pre-send checks, smaller fixes ──────────────────────

const { handleTemplateStatusWebhook } = require("../utils/templateStatus");

// What the scheduler does every minute, for this campaign only, once its
// automatic pause is due to end.
async function autoResume(id) {
  const c = await getCampaign(id);
  if (c.resumeAt) await sleep(Math.max(0, new Date(c.resumeAt).getTime() - Date.now()) + 200);
  await scheduler.schedulerTick({ campaignIds: [id] });
}
const failedRows = async (id) => (await recipientsOf(id)).filter((r) => r.status === "FAILED");

for (const [label, step] of [["Meta temporary error 131000", { code: 131000 }], ["network refused", "refused"]]) {
  section(`errors: ${label} for a while — nobody burned, resumes itself`, async () => {
    fakeMeta.reset();
    const { campaign, phones } = await makeCampaign(12);
    // Enough failures to exhaust the retries (each send tries 4 times).
    fakeMeta.failNext(step, 25);
    await settle(campaigns.processCampaign(campaign.id));
    const paused = await getCampaign(campaign.id);
    check(`${label}: campaign pauses itself (CONNECTION) with a resume time`, paused.status === "PAUSED" && paused.pauseReason === "CONNECTION" && Boolean(paused.resumeAt),
      `→ ${paused.status} ${paused.pauseReason}`);
    check(`${label}: nobody marked FAILED`, (await failedRows(campaign.id)).length === 0);
    fakeMeta.failNext(step, 0); // outage over
    await autoResume(campaign.id);
    const done = await waitStatus(campaign.id, ["COMPLETED"], 40_000);
    const once = exactlyOnce(sendsByPhone(phones));
    check(`${label}: resumes on its own and completes, everyone exactly once`, Boolean(done) && once.ok, `${done ? "COMPLETED" : (await getCampaign(campaign.id)).status}; ${once.detail}`);
  });
}

section("errors: timeouts — 'Not confirmed', never resent, pauses after 3", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(12);
  fakeMeta.failNext("timeout", 8);
  await settle(campaigns.processCampaign(campaign.id));
  const paused = await getCampaign(campaign.id);
  const unconfirmed = (await recipientsOf(campaign.id)).filter((r) => /not confirmed/i.test(r.error || "")).length;
  check("timeouts: campaign pauses (CONNECTION) instead of burning everyone", paused.status === "PAUSED" && paused.pauseReason === "CONNECTION", `→ ${paused.status} ${paused.pauseReason}`);
  check("timeouts: only the few in flight are 'Not confirmed' (3–5)", unconfirmed >= 3 && unconfirmed <= 5, `${unconfirmed} not confirmed`);
  fakeMeta.failNext("timeout", 0);
  await autoResume(campaign.id);
  await waitStatus(campaign.id, ["COMPLETED"], 40_000);
  const amo = await atMostOnce(campaign.id, sendsByPhone(phones));
  check("timeouts: after resuming nobody got it twice", amo.twice.length === 0, amo.detail);
  check("timeouts: everyone else got it", amo.silent.length === 0, amo.detail);
});

section("errors: one recipient's bad data doesn't stop the campaign", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(10);
  fakeMeta.setScript({ [phones[2]]: { code: 132018 } });
  await settle(campaigns.processCampaign(campaign.id));
  const c = await waitStatus(campaign.id, ["COMPLETED", "PAUSED"], 40_000);
  const rows = await recipientsOf(campaign.id);
  const bad = rows.find((r) => r.customer.phone === phones[2]);
  check("bad recipient: campaign completes, not paused", c && c.status === "COMPLETED", `→ ${c && c.status} ${c && c.pauseReason}`);
  check("bad recipient: only that person FAILED, with Meta's reason", bad.status === "FAILED" && /132018/.test(bad.error || "") && rows.filter((r) => r.status === "SENT").length === 9,
    rows.map((r) => r.status[0]).join(""));
});

section("errors: a template-wide parameter error pauses, burns nobody", async () => {
  fakeMeta.reset();
  const { campaign } = await makeCampaign(10);
  fakeMeta.setOutage({ code: 132000 }, 60_000);
  await settle(campaigns.processCampaign(campaign.id));
  const c = await getCampaign(campaign.id);
  check("template-wide error: paused (SEND_ERROR)", c.status === "PAUSED" && c.pauseReason === "SEND_ERROR", `→ ${c.status} ${c.pauseReason}: ${c.pauseDetail}`);
  check("template-wide error: nobody FAILED", (await failedRows(campaign.id)).length === 0);
  fakeMeta.reset();
  await callHandler(campaigns.cancelCampaign, reqFor(campaign.id));
});

section("errors: a token / account error pauses at once", async () => {
  fakeMeta.reset();
  const { campaign } = await makeCampaign(10);
  fakeMeta.setOutage({ code: 190 }, 60_000);
  await settle(campaigns.processCampaign(campaign.id));
  const c = await getCampaign(campaign.id);
  check("token error: paused (SEND_ERROR), needs a person", c.status === "PAUSED" && c.pauseReason === "SEND_ERROR" && !c.resumeAt, `→ ${c.status} ${c.pauseReason}`);
  check("token error: nobody FAILED, at most one try per lane", (await failedRows(campaign.id)).length === 0 && fakeMeta.calls.length <= 5, `${fakeMeta.calls.length} tries`);
  fakeMeta.reset();
  await callHandler(campaigns.cancelCampaign, reqFor(campaign.id));
});

section("errors: Meta rate limit (130429) — pauses, resumes itself", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(10);
  fakeMeta.failNext({ code: 130429 }, 25);
  await settle(campaigns.processCampaign(campaign.id));
  const c = await getCampaign(campaign.id);
  check("rate limit: paused (RATE_LIMIT) with a resume time", c.status === "PAUSED" && c.pauseReason === "RATE_LIMIT" && Boolean(c.resumeAt), `→ ${c.status} ${c.pauseReason}`);
  fakeMeta.failNext({ code: 130429 }, 0);
  await autoResume(campaign.id);
  const done = await waitStatus(campaign.id, ["COMPLETED"], 40_000);
  const once = exactlyOnce(sendsByPhone(phones));
  check("rate limit: completes after the automatic resume, everyone once", Boolean(done) && once.ok, once.detail);
});

section("errors: Meta's per-person limit (131056) only delays that person", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(8);
  fakeMeta.setScript({ [phones[1]]: [{ code: 131056 }, "ok"] });
  const t0 = Date.now();
  await settle(campaigns.processCampaign(campaign.id));
  const c = await waitStatus(campaign.id, ["COMPLETED", "PAUSED"], 40_000);
  const once = exactlyOnce(sendsByPhone(phones));
  check("per-person limit: campaign completes without pausing", c && c.status === "COMPLETED", `→ ${c && c.status} ${c && c.pauseReason}`);
  check("per-person limit: that person got it later, everyone exactly once", once.ok, once.detail);
  check("per-person limit: their retry waited", Date.now() - t0 >= 1500, `${Date.now() - t0}ms`);
});

section("names: a name with a newline or extra spaces still sends", async () => {
  fakeMeta.reset();
  const { campaign } = await makeCampaign(2, { names: ["Ahmed\nAli\t", "Mona      Salem"] });
  await settle(campaigns.processCampaign(campaign.id));
  const c = await waitStatus(campaign.id, ["COMPLETED", "PAUSED"], 30_000);
  const payloadText = JSON.stringify(fakeMeta.calls.map((x) => x.payload));
  check("messy names: campaign completes", c && c.status === "COMPLETED", `→ ${c && c.status} ${c && c.pauseDetail}`);
  check("messy names: no newline, tab or long space run reaches Meta", !/\\n|\\t| {2,}/.test(payloadText.replace(/"[^"]*":/g, "")), payloadText.slice(0, 200));
});

section("pre-send: a deleted template can't be sent", async () => {
  fakeMeta.reset();
  const tpl = await prisma.template.create({ data: { wabaId: ctx.number.wabaId, name: "cc deleted", body: "Hi", category: "CAMPAIGN", approvalStatus: "APPROVED", metaTemplateName: "cc_deleted", isActive: false } });
  made.templates.push(tpl.id);
  const { campaign } = await makeCampaign(3, { status: "DRAFT", templateId: tpl.id });
  const r = await callHandler(campaigns.sendCampaignNow, reqFor(campaign.id));
  const c = await getCampaign(campaign.id);
  check("deleted template: Send now is refused with the reason", r.error?.errorCode === "TEMPLATE_DELETED", r.error?.message || `→ ${r.code}`);
  check("deleted template: still a draft, nothing sent", c.status === "DRAFT" && fakeMeta.calls.length === 0);
});

section("pre-send: Meta pauses the template mid-send", async () => {
  fakeMeta.reset();
  fakeMeta.setDelay(250);
  const tpl = await prisma.template.create({ data: { wabaId: ctx.number.wabaId, name: "cc meta-paused", body: "Hi", category: "CAMPAIGN", approvalStatus: "APPROVED", metaTemplateName: "cc_meta_paused", metaTemplateId: "cc_meta_tpl_1" } });
  made.templates.push(tpl.id);
  const { campaign } = await makeCampaign(15, { templateId: tpl.id });
  let fired = null;
  fakeMeta.onSend(() => { if (!fired) fired = handleTemplateStatusWebhook({ event: "PAUSED", message_template_id: "cc_meta_tpl_1", reason: "LOW_QUALITY" }); });
  await settle(campaigns.processCampaign(campaign.id));
  await fired;
  fakeMeta.setDelay(30);
  const c = await getCampaign(campaign.id);
  check("template paused by Meta: campaign pauses (TEMPLATE_UNAVAILABLE)", c.status === "PAUSED" && c.pauseReason === "TEMPLATE_UNAVAILABLE", `→ ${c.status} ${c.pauseReason}`);
  check("…before everyone was sent", fakeMeta.calls.length < 15, `${fakeMeta.calls.length} of 15`);
  const r1 = await callHandler(campaigns.resumeCampaign, reqFor(campaign.id));
  check("resume is refused while the template is paused", r1.error?.errorCode === "TEMPLATE_PAUSED", r1.error?.message || `→ ${r1.code}`);
  await handleTemplateStatusWebhook({ event: "REINSTATED", message_template_id: "cc_meta_tpl_1" });
  const r2 = await callHandler(campaigns.resumeCampaign, reqFor(campaign.id));
  const done = await waitStatus(campaign.id, ["COMPLETED"], 40_000);
  check("after Meta reinstates it, resume works and it completes", !r2.error && Boolean(done), r2.error?.message || "");
});

section("pre-send: the number is turned off mid-send", async () => {
  fakeMeta.reset();
  fakeMeta.setDelay(250);
  const { campaign } = await makeCampaign(15);
  let off = null;
  fakeMeta.onSend(() => { if (!off) off = prisma.whatsAppNumber.update({ where: { id: ctx.number.id }, data: { isActive: false } }).then((x) => x); });
  await settle(campaigns.processCampaign(campaign.id));
  await off;
  await prisma.whatsAppNumber.update({ where: { id: ctx.number.id }, data: { isActive: true } });
  numbers.invalidate();
  fakeMeta.setDelay(30);
  const c = await getCampaign(campaign.id);
  check("number turned off: campaign pauses (NUMBER_INACTIVE)", c.status === "PAUSED" && c.pauseReason === "NUMBER_INACTIVE", `→ ${c.status} ${c.pauseReason}`);
  check("…within the heartbeat, before everyone was sent", fakeMeta.calls.length < 15, `${fakeMeta.calls.length} of 15`);
  await callHandler(campaigns.cancelCampaign, reqFor(campaign.id));
});

section("control: a person's pause overrides an automatic one", async () => {
  const { campaign } = await makeCampaign(2, { status: "PAUSED" });
  await prisma.campaign.update({ where: { id: campaign.id }, data: { pauseReason: "QUIET_HOURS" } });
  const r = await callHandler(campaigns.pauseCampaign, reqFor(campaign.id));
  await scheduler.schedulerTick({ campaignIds: [campaign.id] });
  const c = await getCampaign(campaign.id);
  check("pausing a quiet-hours pause makes it MANUAL", !r.error && c.pauseReason === "MANUAL", r.error?.message || `→ ${c.pauseReason}`);
  check("…and the morning auto-resume leaves it alone", c.status === "PAUSED", `→ ${c.status}`);
  await callHandler(campaigns.cancelCampaign, reqFor(campaign.id));
});

section("scheduling: past and invalid times are refused", async () => {
  const cust = (await makeCampaign(1, { status: "DRAFT" })).customers[0];
  const base = { name: "CC sched", templateId: ctx.template.id, recipientIds: [cust.id] };
  const past = await callHandler(campaigns.createCampaign, reqFor(0, { body: { ...base, scheduledAt: new Date(Date.now() - 3600_000).toISOString() } }));
  check("a time in the past is refused", past.error?.errorCode === "SCHEDULE_IN_PAST", past.error?.message || `→ ${past.code}`);
  const junk = await callHandler(campaigns.createCampaign, reqFor(0, { body: { ...base, scheduledAt: "next tuesday-ish" } }));
  check("an invalid date is a 400, not a server error", junk.error?.statusCode === 400 && junk.error?.errorCode === "INVALID_SCHEDULE", junk.error?.message || `→ ${junk.code}`);
  for (const r of [past, junk]) if (r.body?.data?.id) made.campaigns.push(r.body.data.id);
});

section("inbox: a failed send to a new contact leaves no empty chat", async () => {
  fakeMeta.reset();
  const { campaign, phones, customers } = await makeCampaign(1);
  fakeMeta.setScript({ [phones[0]]: { code: 131026 } });
  await settle(campaigns.processCampaign(campaign.id));
  const convs = await prisma.conversation.count({ where: { customerId: customers[0].id, whatsappNumberId: ctx.number.id } });
  const r = (await recipientsOf(campaign.id))[0];
  check("not-on-WhatsApp: recipient FAILED with the reason", r.status === "FAILED" && /131026/.test(r.error || ""), `→ ${r.status} ${r.error}`);
  check("…and no empty chat was left in the inbox", convs === 0, `${convs} chats`);
});

section("counts: sent + failed + skipped = total", async () => {
  fakeMeta.reset();
  const { campaign, phones, customers } = await makeCampaign(6);
  await prisma.customer.update({ where: { id: customers[0].id }, data: { optedOut: true } });
  fakeMeta.setScript({ [phones[1]]: { code: 131026 } });
  await settle(campaigns.processCampaign(campaign.id));
  const c = await waitStatus(campaign.id, ["COMPLETED"], 30_000);
  check("counts: 4 sent, 1 failed, 1 skipped of 6", c && c.sentCount === 4 && c.failedCount === 1 && c.skippedCount === 1 && c.totalRecipients === 6,
    c ? `sent ${c.sentCount} failed ${c.failedCount} skipped ${c.skippedCount} total ${c.totalRecipients}` : "not completed");
});

section("consent: opting out mid-send is respected", async () => {
  fakeMeta.reset();
  fakeMeta.setDelay(250);
  const { campaign, phones, customers } = await makeCampaign(10);
  let flagged = null;
  fakeMeta.onSend(() => { if (!flagged) flagged = prisma.customer.update({ where: { id: customers[9].id }, data: { optedOut: true } }).then((x) => x); });
  const outcome = await settle(campaigns.processCampaign(campaign.id));
  await flagged;
  const atReturn = await getCampaign(campaign.id);
  const pendingAtReturn = (await recipientsOf(campaign.id)).filter((r) => ["PENDING", "SENDING"].includes(r.status)).length;
  check("the send loop only returns once it's finished", atReturn.status !== "RUNNING" && pendingAtReturn === 0,
    `loop ${outcome}, campaign ${atReturn.status}, ${pendingAtReturn} still pending`);
  fakeMeta.setDelay(30);
  const c = await waitStatus(campaign.id, ["COMPLETED", "PAUSED", "CANCELLED"], 30_000);
  const last = (await recipientsOf(campaign.id)).find((r) => r.customerId === customers[9].id);
  check("opted out after the send started: skipped, not sent", last.status === "SKIPPED" && sendsByPhone([phones[9]]).get(phones[9]) === 0,
    `→ ${last.status}; campaign ${c ? c.status : "still RUNNING"} ${c?.pauseReason || ""} ${c?.pauseDetail || ""}`);
});

section("delete: bulk delete respects ownership; sent campaigns are hidden, not erased", async () => {
  const marketer = await prisma.user.create({ data: { username: "cc_marketing", passwordHash: "x", role: "MARKETING" } });
  made.users.push(marketer.id);
  const own = (await makeCampaign(1, { status: "DRAFT", createdById: marketer.id })).campaign;
  const others = (await makeCampaign(1, { status: "DRAFT" })).campaign;
  const sent = (await makeCampaign(1, { status: "COMPLETED" })).campaign;
  await prisma.campaign.update({ where: { id: sent.id }, data: { sentCount: 1 } });
  const r = await callHandler(campaigns.bulkDeleteCampaigns, reqFor(0, { user: marketer, body: { ids: [own.id, others.id, sent.id] } }));
  const [o, x, s] = await Promise.all([own, others, sent].map((c) => getCampaign(c.id)));
  check("marketing bulk delete removes only their own draft", r.body?.deletedCount === 1 && !o && x && s && !s.deletedAt, JSON.stringify(r.body || r.error?.message));
  const d = await callHandler(campaigns.deleteCampaign, reqFor(sent.id));
  const hidden = await getCampaign(sent.id);
  const list = await callHandler(campaigns.getCampaigns, reqFor(0));
  check("deleting a sent campaign hides it but keeps the record", !d.error && hidden && hidden.deletedAt !== null, d.error?.message || "");
  check("…and it's gone from the campaign list", !list.body.data.some((c) => c.id === sent.id));
});

section("paging: a campaign bigger than one page sends everyone once", async () => {
  fakeMeta.reset();
  const { campaign, phones } = await makeCampaign(23); // pages of 7
  await settle(campaigns.processCampaign(campaign.id));
  const c = await waitStatus(campaign.id, ["COMPLETED"], 60_000);
  const once = exactlyOnce(sendsByPhone(phones));
  check("23 recipients in pages of 7: completes, everyone exactly once", Boolean(c) && once.ok, once.detail);
});

// Last on purpose: beginShutdown() flips a process-wide flag that is never
// turned back off (the process is about to exit).
section("shutdown: SIGTERM while sending (graceful drain)", async () => {
  fakeMeta.reset();
  fakeMeta.setDelay(300);
  const { campaign, phones } = await makeCampaign(20);
  let drained = null;
  fakeMeta.onSend(() => { if (!drained) drained = campaigns.beginShutdown(25_000); });
  const outcome = await settle(campaigns.processCampaign(campaign.id));
  const ok = await drained;
  fakeMeta.setDelay(30);
  const c = await getCampaign(campaign.id);
  const rs = await recipientsOf(campaign.id);
  const sent = [...sendsByPhone(phones).values()].reduce((a, b) => a + b, 0);
  check("shutdown: in-flight sends finish and the loop exits", ok && outcome === "resolved", `drained ${ok}, loop ${outcome}`);
  check("shutdown: stops picking up new people", sent < 20, `${sent} of 20 sent`);
  check("shutdown: nothing left SENDING (no 'Not confirmed' from a clean stop)", rs.every((r) => r.status !== "SENDING"), rs.map((r) => r.status[0]).join(""));
  check("shutdown: every send Meta got is recorded SENT", rs.filter((r) => r.status === "SENT").length === sent, `${rs.filter((r) => r.status === "SENT").length} SENT vs ${sent} sent`);
  check("shutdown: campaign stays RUNNING with its lease released, for the next process",
    c.status === "RUNNING" && c.lockedBy === null, `→ ${c.status}, lockedBy ${c.lockedBy}`);
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED" } });
});

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  await require("./support/noLiveBackend").requireNoLiveBackend();
  const filter = process.argv[2];
  try {
    const admin = await prisma.user.create({ data: { username: "cc_admin", passwordHash: "x", role: "ADMIN" } });
    made.users.push(admin.id);
    const number = await prisma.whatsAppNumber.create({
      data: { label: "Campaign check", phoneNumberId: PNID, wabaId: "waba_cc", tokenEnvKey: "WHATSAPP_TOKEN_CAMPAIGNCHECK", sendConcurrency: 5 },
    });
    made.numbers.push(number.id);
    numbers.invalidate();
    const template = await prisma.template.create({
      data: { wabaId: number.wabaId, name: "cc template", body: "Hi {{first_name}}, book now", category: "CAMPAIGN", approvalStatus: "APPROVED", metaTemplateName: "cc_template" },
    });
    made.templates.push(template.id);
    ctx = { admin, number, template };

    for (const s of sections) {
      if (filter && !s.name.includes(filter)) continue;
      console.log(`\n${B}${s.name}${RESET}`);
      try {
        await s.fn();
      } catch (err) {
        check(`${s.name}: section ran without crashing`, false, err.stack || err.message);
      }
      // Let any loop the section started finish before the next one.
      await waitFor(async () => (await prisma.campaign.count({ where: { id: { in: made.campaigns }, status: "RUNNING" } })) === 0, 20_000);
    }
    check("no unhandled promise rejections", unhandled.length === 0, unhandled.map((e) => (e && e.message) || String(e)).join(" | "));
  } finally {
    const customerIds = made.customers;
    const convs = await prisma.conversation.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: made.campaigns } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.template.deleteMany({ where: { id: { in: made.templates } } });
    await prisma.customerOptOut.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.auditLog.deleteMany({ where: { targetType: "Campaign", targetId: { in: made.campaigns } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.whatsAppNumber.deleteMany({ where: { id: { in: made.numbers } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    numbers.invalidate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`${R}Check crashed:${RESET}`, err);
  await prisma.$disconnect();
  process.exit(1);
});
