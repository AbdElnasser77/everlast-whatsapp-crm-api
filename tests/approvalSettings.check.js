// Campaign approval + Settings check.
//
// Approval: marketing builds and submits, only an admin approves (which sends
// or schedules) or rejects with a reason; the checks an approval re-runs
// (template, number quality, Meta's daily limit).
// Settings: quiet hours and campaign safety are validated and take effect;
// the per-patient campaign limit skips people; a dropped quality rating holds
// and pauses campaigns; WhatsApp numbers can be added and managed; a user can
// rename themselves.
//
// Drives the REAL handlers and send loop with only Meta faked
// (tests/support/fakeMeta.js). Creates only its own tagged rows (a throwaway
// number, phones starting TAG, users named as_*) and deletes exactly those in
// a finally block; the default-number flag and any saved setting it touches
// are put back.
//
//   npm run check:approval-settings

process.env.QUIET_HOURS_FORCE_ENV = "1";
process.env.QUIET_HOURS_START = "00:00";
process.env.QUIET_HOURS_END = "00:00";
process.env.APP_SETTINGS_IGNORE_SAVED = "1";
process.env.WHATSAPP_TOKEN_APPROVALCHECK = "fake-token";

const fakeMeta = require("./support/fakeMeta");
fakeMeta.install();
require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });

const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const campaigns = require("../modules/campaigns/campaign.controller");
const settingsCtl = require("../modules/settings/settings.controller");
const usersCtl = require("../modules/users/user.controller");
const appSettings = require("../utils/appSettings");
const { checkNumberQuality } = require("../jobs/numberQualityWatch");
const { _tierCache } = require("../utils/messagingCapacity");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m";
const TAG = "999557";
const PNID = "90000557000001";
const PNID_NEW = "90000557000002";
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = { numbers: [], customers: [], users: [], templates: [], campaigns: [] };
let ctx;
let seq = 0;

function call(handler, req) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { resolve({ code: this.code, body }); } };
    Promise.resolve(handler(req, res, (err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
  });
}
const req = (user, extra = {}) => ({ params: {}, body: {}, query: {}, user, numberId: ctx.number.id, number: ctx.number, ...extra });

async function customers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = await prisma.customer.create({ data: { name: `AS Person ${++seq}`, phone: `${TAG}${String(seq).padStart(5, "0")}` } });
    made.customers.push(c.id);
    out.push(c);
  }
  return out;
}
async function create(user, body) {
  const r = await call(campaigns.createCampaign, req(user, { body }));
  if (r.body?.data?.id) made.campaigns.push(r.body.data.id);
  return r;
}
const getCampaign = (id) => prisma.campaign.findUnique({ where: { id } });
async function waitFor(fn, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await sleep(250); }
  return null;
}
const settled = (id) => waitFor(async () => { const c = await getCampaign(id); return c && !["RUNNING"].includes(c.status) ? c : null; });

// ── sections ────────────────────────────────────────────────────────────────

async function approvalFlow() {
  console.log(`\n${B}approval: marketing submits, admin decides${RESET}`);
  const { admin, marketer, marketer2 } = ctx;
  const people = await customers(3);
  const future = new Date(Date.now() + 3 * DAY);
  future.setUTCHours(8, 0, 0, 0); // 12:00 Dubai — outside quiet hours either way

  const created = await create(marketer, { name: "AS marketing campaign", templateId: ctx.template.id, recipientIds: people.map((p) => p.id), scheduledAt: future.toISOString() });
  check("marketing can create a campaign with a proposed time", created.code === 201, created.error?.message || "");
  const id = created.body.data.id;
  check("…but it starts as a DRAFT, not SCHEDULED", created.body.data.status === "DRAFT", `→ ${created.body.data.status}`);

  const notMine = await call(campaigns.submitCampaign, req(marketer2, { params: { id: String(id) } }));
  check("another marketing user can't submit someone else's draft", notMine.error?.statusCode === 403, notMine.error?.message || `→ ${notMine.code}`);

  const sub = await call(campaigns.submitCampaign, req(marketer, { params: { id: String(id) } }));
  check("marketing submits it for approval", sub.code === 200 && (await getCampaign(id)).status === "PENDING_APPROVAL", sub.error?.message || "");

  const editLocked = await call(campaigns.updateCampaign, req(marketer, { params: { id: String(id) }, body: { name: "changed" } }));
  check("once submitted, marketing can't edit it", Boolean(editLocked.error), editLocked.error?.message || "edited");

  const pending = await call(campaigns.getPendingApprovals, req(admin));
  check("it shows in the admin's pending-approval list", pending.body?.data?.some((c) => c.id === id), `total ${pending.body?.total}`);

  const noReason = await call(campaigns.rejectCampaign, req(admin, { params: { id: String(id) }, body: { reason: "  " } }));
  check("rejecting needs a reason", noReason.error?.statusCode === 400, noReason.error?.message || "");

  const rej = await call(campaigns.rejectCampaign, req(admin, { params: { id: String(id) }, body: { reason: "Wrong offer dates" } }));
  let c = await getCampaign(id);
  check("admin rejects: back to DRAFT with the reason", rej.code === 200 && c.status === "DRAFT" && c.rejectionReason === "Wrong offer dates", `→ ${c.status} "${c.rejectionReason}"`);

  const edit = await call(campaigns.updateCampaign, req(marketer, { params: { id: String(id) }, body: { name: "AS marketing campaign v2" } }));
  check("the creator can edit the rejected draft", edit.code === 200, edit.error?.message || "");
  await call(campaigns.submitCampaign, req(marketer, { params: { id: String(id) } }));
  c = await getCampaign(id);
  check("resubmitting clears the old rejection", c.status === "PENDING_APPROVAL" && c.rejectionReason === null, `→ ${c.status} "${c.rejectionReason}"`);

  const appr = await call(campaigns.approveCampaign, req(admin, { params: { id: String(id) } }));
  c = await getCampaign(id);
  check("admin approves a future-dated one: it is SCHEDULED, nothing sent", appr.code === 200 && c.status === "SCHEDULED" && fakeMeta.calls.length === 0,
    `→ ${c.status}, ${fakeMeta.calls.length} sends`);
  check("…and the approval is recorded", c.reviewedById === admin.id && Boolean(c.reviewedAt));
  await call(campaigns.cancelCampaign, req(admin, { params: { id: String(id) } }));

  // Approve-now path: sends.
  const now = await create(marketer, { name: "AS send-now", templateId: ctx.template.id, recipientIds: (await customers(2)).map((p) => p.id) });
  await call(campaigns.submitCampaign, req(marketer, { params: { id: String(now.body.data.id) } }));
  fakeMeta.reset();
  const a2 = await call(campaigns.approveCampaign, req(admin, { params: { id: String(now.body.data.id) } }));
  const done = await settled(now.body.data.id);
  check("approving one with no time sends it now", a2.code === 200 && done?.status === "COMPLETED" && fakeMeta.calls.length === 2,
    `→ ${done?.status}, ${fakeMeta.calls.length} sends`);
}

async function approvalRechecks() {
  console.log(`\n${B}approval: re-checks at approval time${RESET}`);
  const { admin, marketer } = ctx;

  // Template deleted between submit and approve.
  const tpl = await prisma.template.create({ data: { wabaId: ctx.number.wabaId, name: "as doomed", body: "Hi", category: "CAMPAIGN", approvalStatus: "APPROVED", metaTemplateName: "as_doomed" } });
  made.templates.push(tpl.id);
  const c1 = await create(marketer, { name: "AS doomed", templateId: tpl.id, recipientIds: (await customers(1)).map((p) => p.id) });
  await call(campaigns.submitCampaign, req(marketer, { params: { id: String(c1.body.data.id) } }));
  await prisma.template.update({ where: { id: tpl.id }, data: { isActive: false } });
  fakeMeta.reset();
  const r1 = await call(campaigns.approveCampaign, req(admin, { params: { id: String(c1.body.data.id) } }));
  check("approving after the template was deleted is refused", r1.error?.errorCode === "TEMPLATE_DELETED", r1.error?.message || `→ ${r1.code}`);
  check("…it stays waiting and nothing is sent", (await getCampaign(c1.body.data.id)).status === "PENDING_APPROVAL" && fakeMeta.calls.length === 0);

  // Over Meta's daily limit.
  _tierCache.clear();
  fakeMeta.setTier("TIER_50");
  const c2 = await create(marketer, { name: "AS big", templateId: ctx.template.id, recipientIds: (await customers(60)).map((p) => p.id) });
  await call(campaigns.submitCampaign, req(marketer, { params: { id: String(c2.body.data.id) } }));
  fakeMeta.reset();
  const r2 = await call(campaigns.approveCampaign, req(admin, { params: { id: String(c2.body.data.id) } }));
  check("over the daily limit: approval asks for confirmation", r2.error?.errorCode === "OVER_MESSAGING_LIMIT" && r2.error.details?.needed === 60,
    r2.error ? `${r2.error.message}` : `→ ${r2.code}`);
  check("…and nothing was sent", fakeMeta.calls.length === 0 && (await getCampaign(c2.body.data.id)).status === "PENDING_APPROVAL");
  const r3 = await call(campaigns.approveCampaign, req(admin, { params: { id: String(c2.body.data.id) }, body: { confirmOverLimit: true } }));
  check("confirming sends it anyway", r3.code === 200, r3.error?.message || "");
  await call(campaigns.cancelCampaign, req(admin, { params: { id: String(c2.body.data.id) } }));
  await settled(c2.body.data.id);
  _tierCache.clear();
  fakeMeta.setTier(null);
}

async function quietHoursSetting() {
  console.log(`\n${B}settings: quiet hours${RESET}`);
  const { admin } = ctx;
  const bad = await call(settingsCtl.updateSetting, req(admin, { params: { key: "quietHours" }, body: { start: "25:00", end: "09:00" } }));
  check("an invalid time is refused", bad.error?.statusCode === 400, bad.error?.message || "");
  const same = await call(settingsCtl.updateSetting, req(admin, { params: { key: "quietHours" }, body: { start: "09:00", end: "09:00" } }));
  check("start = end is refused", same.error?.statusCode === 400, same.error?.message || "");
  const tz = await call(settingsCtl.updateSetting, req(admin, { params: { key: "quietHours" }, body: { start: "21:00", end: "09:00", timezone: "Mars/Olympus" } }));
  check("an unknown time zone is refused", tz.error?.statusCode === 400, tz.error?.message || "");

  // A valid save, read back through the real quiet-hours config.
  delete process.env.QUIET_HOURS_FORCE_ENV;
  delete process.env.APP_SETTINGS_IGNORE_SAVED;
  const ok = await call(settingsCtl.updateSetting, req(admin, { params: { key: "quietHours" }, body: { enabled: true, start: "22:30", end: "08:00", timezone: "Asia/Dubai" } }));
  const { getQuietHoursConfig } = require("../utils/quietHours");
  const cfg = getQuietHoursConfig();
  check("a valid save takes effect at once", ok.code === 200 && cfg.source === "settings" && cfg.start === "22:30" && cfg.end === "08:00" && cfg.enabled,
    `→ ${cfg.source} ${cfg.start}-${cfg.end}`);
  const off = await call(settingsCtl.updateSetting, req(admin, { params: { key: "quietHours" }, body: { enabled: false, start: "22:30", end: "08:00", timezone: "Asia/Dubai" } }));
  check("turning quiet hours off works", off.code === 200 && getQuietHoursConfig().enabled === false);
  process.env.QUIET_HOURS_FORCE_ENV = "1";
  process.env.APP_SETTINGS_IGNORE_SAVED = "1";
}

async function frequencyCap() {
  console.log(`\n${B}settings: one campaign per patient every N days${RESET}`);
  const { admin } = ctx;
  const bad = await call(settingsCtl.updateSetting, req(admin, { params: { key: "campaignSafety" }, body: { frequencyCapDays: 400 } }));
  check("a limit over 90 days is refused", bad.error?.statusCode === 400, bad.error?.message || "");
  const empty = await call(settingsCtl.updateSetting, req(admin, { params: { key: "campaignSafety" }, body: {} }));
  check("an empty save is refused (can't silently reset)", empty.error?.statusCode === 400, empty.error?.message || "");

  appSettings.overrideSettingForTest("campaignSafety", { frequencyCapDays: 7, qualityAutoPause: true, qualityPauseAt: "YELLOW" });
  const [recent, fresh] = await customers(2);
  fakeMeta.reset();
  const first = await create(admin, { name: "AS first", templateId: ctx.template.id, recipientIds: [recent.id] });
  await call(campaigns.sendCampaignNow, req(admin, { params: { id: String(first.body.data.id) } }));
  await settled(first.body.data.id);
  const second = await create(admin, { name: "AS second", templateId: ctx.template.id, recipientIds: [recent.id, fresh.id] });
  await call(campaigns.sendCampaignNow, req(admin, { params: { id: String(second.body.data.id) } }));
  const done = await settled(second.body.data.id);
  const rows = await prisma.campaignRecipient.findMany({ where: { campaignId: second.body.data.id } });
  const r = rows.find((x) => x.customerId === recent.id);
  const f = rows.find((x) => x.customerId === fresh.id);
  check("someone who got a campaign 0 days ago is skipped, with the reason", r.status === "SKIPPED" && /limit is one campaign every 7/.test(r.error || ""), `→ ${r.status} ${r.error}`);
  check("someone who didn't still gets it", f.status === "SENT", `→ ${f.status}`);
  check("the campaign still completes, skipped counted", done?.status === "COMPLETED" && done.skippedCount === 1, `→ ${done?.status} skipped ${done?.skippedCount}`);
  appSettings.overrideSettingForTest("campaignSafety", undefined);
}

async function qualityHold() {
  console.log(`\n${B}settings: pause on low quality${RESET}`);
  const { admin } = ctx;
  appSettings.overrideSettingForTest("campaignSafety", { frequencyCapDays: 0, qualityAutoPause: true, qualityPauseAt: "YELLOW" });

  // A running campaign, then Meta reports the number went YELLOW.
  fakeMeta.reset();
  fakeMeta.setDelay(250);
  const c = await create(admin, { name: "AS quality", templateId: ctx.template.id, recipientIds: (await customers(15)).map((p) => p.id) });
  await call(campaigns.sendCampaignNow, req(admin, { params: { id: String(c.body.data.id) } }));
  await waitFor(() => fakeMeta.calls.length > 0, 10_000);
  fakeMeta.setNumberInfo({ quality_rating: "YELLOW", status: "CONNECTED", display_phone_number: "+971 50 000 0000" });
  const results = await checkNumberQuality({ numberIds: [ctx.number.id] });
  const after = await settled(c.body.data.id);
  check("quality YELLOW: the running campaign pauses (QUALITY)", after?.status === "PAUSED" && after.pauseReason === "QUALITY", `→ ${after?.status} ${after?.pauseReason}; ${JSON.stringify(results[0])}`);
  check("…before everyone was sent", fakeMeta.calls.length < 15, `${fakeMeta.calls.length} of 15 sent`);
  fakeMeta.setDelay(30);

  const resume = await call(campaigns.resumeCampaign, req(admin, { params: { id: String(c.body.data.id) } }));
  check("resuming while quality is low is refused", resume.error?.errorCode === "NUMBER_QUALITY", resume.error?.message || `→ ${resume.code}`);

  appSettings.overrideSettingForTest("campaignSafety", { frequencyCapDays: 0, qualityAutoPause: true, qualityPauseAt: "RED" });
  const resume2 = await call(campaigns.resumeCampaign, req(admin, { params: { id: String(c.body.data.id) } }));
  check("with the threshold at RED, YELLOW no longer holds it", resume2.code === 200, resume2.error?.message || "");
  await call(campaigns.cancelCampaign, req(admin, { params: { id: String(c.body.data.id) } }));
  await settled(c.body.data.id);

  fakeMeta.setNumberInfo({ quality_rating: "GREEN", status: "CONNECTED", display_phone_number: "+971 50 000 0000" });
  await checkNumberQuality({ numberIds: [ctx.number.id] });
  appSettings.overrideSettingForTest("campaignSafety", undefined);
  numbers.invalidate();
  ctx.number = await prisma.whatsAppNumber.findUnique({ where: { id: ctx.number.id } });
}

async function numberAdmin() {
  console.log(`\n${B}settings: WhatsApp numbers${RESET}`);
  const { admin } = ctx;
  const missing = await call(settingsCtl.createNumber, req(admin, { body: { label: "x" } }));
  check("adding a number needs all fields", missing.error?.statusCode === 400, missing.error?.message || "");
  const badKey = await call(settingsCtl.createNumber, req(admin, { body: { label: "AS new", phoneNumberId: PNID_NEW, wabaId: "90000557", tokenEnvKey: "WHATSAPP_TOKEN_DOES_NOT_EXIST" } }));
  check("a token that isn't on the server is refused", badKey.error?.statusCode === 400, badKey.error?.message || "");
  fakeMeta.setNumberInfo(null);
  const rejected = await call(settingsCtl.createNumber, req(admin, { body: { label: "AS new", phoneNumberId: PNID_NEW, wabaId: "90000557", tokenEnvKey: "WHATSAPP_TOKEN_APPROVALCHECK" } }));
  check("a number Meta doesn't accept is refused", rejected.error?.errorCode === "NUMBER_LOOKUP_FAILED", rejected.error?.message || "");
  fakeMeta.setNumberInfo({ quality_rating: "GREEN", status: "CONNECTED", display_phone_number: "+971 55 123 4567" });
  const ok = await call(settingsCtl.createNumber, req(admin, { body: { label: "AS new", phoneNumberId: PNID_NEW, wabaId: "90000557", tokenEnvKey: "WHATSAPP_TOKEN_APPROVALCHECK", sendConcurrency: 3 } }));
  if (ok.body?.data?.id) made.numbers.push(ok.body.data.id);
  check("a valid number is added, with Meta's display number filled in", ok.code === 201 && ok.body.data.displayPhoneNumber === "+971 55 123 4567" && ok.body.data.isDefault === false,
    ok.error?.message || JSON.stringify(ok.body?.data));
  const dup = await call(settingsCtl.createNumber, req(admin, { body: { label: "AS dup", phoneNumberId: PNID_NEW, wabaId: "90000557", tokenEnvKey: "WHATSAPP_TOKEN_APPROVALCHECK" } }));
  check("the same number can't be added twice", dup.error?.statusCode === 409, dup.error?.message || "");
  const list = await call(settingsCtl.listNumbers, req(admin));
  check("the token list shows names only, never values", Array.isArray(list.body?.tokenKeys) && list.body.tokenKeys.every((k) => numbers.TOKEN_ENV_KEY_RE.test(k)) && !JSON.stringify(list.body).includes("fake-token"));

  const newId = ok.body.data.id;
  const speed = await call(settingsCtl.updateNumber, req(admin, { params: { id: String(newId) }, body: { sendConcurrency: 50 } }));
  check("send speed over 20 is refused", speed.error?.statusCode === 400, speed.error?.message || "");
  const rename = await call(settingsCtl.updateNumber, req(admin, { params: { id: String(newId) }, body: { label: "AS renamed" } }));
  check("renaming works", rename.body?.data?.label === "AS renamed");

  // Default switching, then put the real default back.
  const originalDefaults = (await prisma.whatsAppNumber.findMany({ where: { isDefault: true }, select: { id: true } })).map((n) => n.id);
  try {
    const mk = await call(settingsCtl.updateNumber, req(admin, { params: { id: String(newId) }, body: { isDefault: true } }));
    const defaults = await prisma.whatsAppNumber.findMany({ where: { isDefault: true }, select: { id: true } });
    check("making a number default leaves exactly one default", mk.code === 200 && defaults.length === 1 && defaults[0].id === newId, `defaults ${defaults.map((d) => d.id)}`);
    const offDefault = await call(settingsCtl.updateNumber, req(admin, { params: { id: String(newId) }, body: { isActive: false } }));
    check("the default number can't be turned off", offDefault.error?.statusCode === 400, offDefault.error?.message || "");
  } finally {
    await prisma.whatsAppNumber.updateMany({ where: { id: newId }, data: { isDefault: false } });
    if (originalDefaults.length) await prisma.whatsAppNumber.updateMany({ where: { id: { in: originalDefaults } }, data: { isDefault: true } });
    numbers.invalidate();
  }
  const restored = (await prisma.whatsAppNumber.findMany({ where: { isDefault: true }, select: { id: true } })).map((n) => n.id).sort();
  check("…and the real default number is back", JSON.stringify(restored) === JSON.stringify(originalDefaults.sort()), `defaults ${restored}`);

  const off = await call(settingsCtl.updateNumber, req(admin, { params: { id: String(newId) }, body: { isActive: false } }));
  check("a non-default number can be turned off", off.body?.data?.isActive === false, off.error?.message || "");
  const defOff = await call(settingsCtl.updateNumber, req(admin, { params: { id: String(newId) }, body: { isDefault: true } }));
  check("an inactive number can't become default", defOff.error?.statusCode === 400, defOff.error?.message || "");
}

async function myAccount() {
  console.log(`\n${B}settings: my account${RESET}`);
  const { marketer } = ctx;
  const empty = await call(usersCtl.updateMyProfile, req(marketer, { body: { name: "   " } }));
  check("an empty name is refused", empty.error?.statusCode === 400, empty.error?.message || "");
  const ok = await call(usersCtl.updateMyProfile, req(marketer, { body: { name: "Mona (Marketing)" } }));
  const row = await prisma.user.findUnique({ where: { id: marketer.id } });
  check("a user can rename themselves", ok.code === 200 && row.name === "Mona (Marketing)", ok.error?.message || "");
  check("…and nothing else about them changes", row.role === "MARKETING" && row.username === marketer.username);
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  await require("./support/noLiveBackend").requireNoLiveBackend();
  try {
    const mk = async (username, role) => {
      const u = await prisma.user.create({ data: { username, passwordHash: "x", role } });
      made.users.push(u.id);
      return u;
    };
    const admin = await mk("as_admin", "ADMIN");
    const marketer = await mk("as_marketing", "MARKETING");
    const marketer2 = await mk("as_marketing2", "MARKETING");
    const number = await prisma.whatsAppNumber.create({
      data: { label: "Approval check", phoneNumberId: PNID, wabaId: "waba_as", tokenEnvKey: "WHATSAPP_TOKEN_APPROVALCHECK" },
    });
    made.numbers.push(number.id);
    numbers.invalidate();
    const template = await prisma.template.create({
      data: { wabaId: number.wabaId, name: "as template", body: "Hi {{first_name}}", category: "CAMPAIGN", approvalStatus: "APPROVED", metaTemplateName: "as_template" },
    });
    made.templates.push(template.id);
    ctx = { admin, marketer, marketer2, number, template };

    for (const s of [approvalFlow, approvalRechecks, quietHoursSetting, frequencyCap, qualityHold, numberAdmin, myAccount]) {
      try {
        await s();
      } catch (err) {
        check(`${s.name} ran without crashing`, false, err.stack || err.message);
      }
    }
  } finally {
    await waitFor(async () => (await prisma.campaign.count({ where: { id: { in: made.campaigns }, status: "RUNNING" } })) === 0, 30_000);
    const convs = await prisma.conversation.findMany({ where: { customerId: { in: made.customers } }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: made.campaigns } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.template.deleteMany({ where: { id: { in: made.templates } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
    await prisma.whatsAppNumber.deleteMany({ where: { id: { in: made.numbers } } });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { targetType: "Campaign", targetId: { in: made.campaigns } },
          { targetType: "WhatsAppNumber", targetId: { in: made.numbers } },
          { actorId: { in: made.users } },
        ],
      },
    });
    // The quiet-hours section saved a real setting; this check must leave none.
    await prisma.appSetting.deleteMany({ where: { updatedById: { in: made.users } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    numbers.invalidate();
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
