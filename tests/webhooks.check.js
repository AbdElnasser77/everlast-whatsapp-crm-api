// Webhook durability, opt-out words, reply credit and the error handler.
//
// Drives the REAL webhook handler (receiveWhatsAppMessage), the recovery job
// and the real errorHandler with Meta-shaped payloads. Nothing is sent to Meta
// (inbound handling never calls it; flows are not attached here).
//
// Creates only its own tagged rows — a throwaway number, phones starting TAG,
// webhook events marked with WABA_MARK — and deletes exactly those in a
// finally block.
//
//   npm run check:webhooks

process.env.WHATSAPP_TOKEN_WEBHOOKCHECK = "fake-token";
process.env.WEBHOOK_STATUS_RETRY_MS = "300,1500";

require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });
const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const AppError = require("../utils/AppError");
const errorHandler = require("../middleware/errorHandler");
const { receiveWhatsAppMessage } = require("../modules/webhooks/webhook.controller");
const { recoverWebhookEvents } = require("../jobs/webhookRecovery");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m";
const TAG = "999558";
const PNID = "__webhook_check_pnid__";
const WABA_MARK = "waba_webhook_check";
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const made = { numbers: [], customers: [], users: [], campaigns: [], templates: [] };
let number;
let seq = 0;

const phone = () => `${TAG}${String(++seq).padStart(5, "0")}`;
const wamid = (tag) => `wamid.webhookcheck.${Date.now()}.${tag}.${++seq}`;

function inboundBody(from, msg) {
  return {
    entry: [{ id: WABA_MARK, changes: [{ field: "messages", value: {
      metadata: { phone_number_id: PNID },
      contacts: [{ wa_id: from, profile: { name: `WH ${from.slice(-3)}` } }],
      messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
    } }] }],
  };
}
function statusBody(id, status, extra = {}) {
  return {
    entry: [{ id: WABA_MARK, changes: [{ field: "messages", value: {
      metadata: { phone_number_id: PNID },
      statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), ...extra }],
    } }] }],
  };
}
// Deliver like Meta: returns what the handler answered and when.
async function deliver(body) {
  const answered = {};
  await receiveWhatsAppMessage({ body }, { sendStatus: (code) => { answered.code = code; answered.at = Date.now(); } });
  return answered;
}
const messagesWith = (id) => prisma.message.count({ where: { whatsappMessageId: id } });
async function trackCustomer(p) {
  const c = await prisma.customer.findUnique({ where: { phone: p } });
  if (c && !made.customers.includes(c.id)) made.customers.push(c.id);
  return c;
}

// ── sections ────────────────────────────────────────────────────────────────

async function durability() {
  console.log(`
${B}webhooks: saved before Meta gets its 200${RESET}`);
  const from = phone();
  const id = wamid("durable");
  // Record the moment the save finishes and the moment Meta is answered.
  const realCreate = prisma.webhookEvent.create.bind(prisma.webhookEvent);
  let savedAt = null;
  prisma.webhookEvent.create = async (args) => { const row = await realCreate(args); savedAt = Date.now(); return row; };
  let answered;
  try {
    answered = await deliver(inboundBody(from, { id, type: "text", text: { body: "hello" } }));
  } finally {
    prisma.webhookEvent.create = realCreate;
  }
  await trackCustomer(from);
  check("the delivery is saved before Meta is answered 200", answered.code === 200 && savedAt !== null && savedAt <= answered.at, `saved ${savedAt}, answered ${answered.at}`);
  const ev = (await prisma.webhookEvent.findMany({ orderBy: { id: "desc" }, take: 20 })).find((e) => JSON.stringify(e.payload).includes(id));
  check("…and marked processed once handled", ev && ev.processedAt !== null && ev.attempts === 1, ev ? `attempts ${ev.attempts}` : "no event");
  check("…the message is in the inbox", (await messagesWith(id)) === 1);

  // If the save itself fails, Meta must get an error so it re-sends.
  prisma.webhookEvent.create = async () => { throw new Error("database down"); };
  let failedAnswer;
  try {
    failedAnswer = await deliver(inboundBody(phone(), { id: wamid("dbdown"), type: "text", text: { body: "x" } }));
  } finally {
    prisma.webhookEvent.create = realCreate;
  }
  check("if the delivery can't be saved, Meta gets a 500 (and re-sends later)", failedAnswer.code === 500, `→ ${failedAnswer.code}`);
}

async function recovery() {
  console.log(`\n${B}webhooks: unfinished deliveries are recovered, never doubled${RESET}`);
  const from = phone();
  const id = wamid("recover");
  // As if the process died right after saving (before handling).
  const ev = await prisma.webhookEvent.create({ data: { payload: inboundBody(from, { id, type: "text", text: { body: "are you open today?" } }) } });
  check("before recovery: the message isn't in the inbox", (await messagesWith(id)) === 0);
  const r1 = await recoverWebhookEvents({ ids: [ev.id] });
  await trackCustomer(from);
  const after = await prisma.webhookEvent.findUnique({ where: { id: ev.id } });
  check("recovery handles it: the message appears, event marked processed", (await messagesWith(id)) === 1 && after.processedAt !== null, JSON.stringify(r1));

  // Replay the very same delivery (Meta re-sent it, or recovery ran twice).
  await prisma.webhookEvent.update({ where: { id: ev.id }, data: { processedAt: null } });
  await recoverWebhookEvents({ ids: [ev.id] });
  check("replaying the same delivery doesn't duplicate the message", (await messagesWith(id)) === 1);

  // Two copies arriving at the same moment.
  const from2 = phone();
  const id2 = wamid("concurrent");
  const body = inboundBody(from2, { id: id2, type: "text", text: { body: "hi" } });
  await Promise.all([deliver(body), deliver(body)]);
  await trackCustomer(from2);
  check("two identical deliveries at once: one message", (await messagesWith(id2)) === 1);

  let dupErr = null;
  const msg = await prisma.message.findFirst({ where: { whatsappMessageId: id2 } });
  try {
    await prisma.message.create({ data: { conversationId: msg.conversationId, senderType: "CUSTOMER", content: "x", messageType: "TEXT", whatsappMessageId: id2 } });
  } catch (e) { dupErr = e; }
  check("the database itself refuses a duplicate WhatsApp message id", dupErr?.code === "P2002", dupErr ? dupErr.code : "inserted");
}

async function statusRace() {
  console.log(`\n${B}webhooks: a status that arrives before its message is saved${RESET}`);
  const from = phone();
  await deliver(inboundBody(from, { id: wamid("seed"), type: "text", text: { body: "seed" } }));
  const customer = await trackCustomer(from);
  const conv = await prisma.conversation.findFirst({ where: { customerId: customer.id, whatsappNumberId: number.id } });
  const out = await prisma.message.create({ data: { conversationId: conv.id, senderType: "AGENT", content: "{}", messageType: "TEMPLATE", status: "PENDING" } });
  const id = wamid("race");
  const delivering = deliver(statusBody(id, "failed", { errors: [{ code: 131026, title: "Undeliverable" }] }));
  await sleep(500); // the sender saves Meta's id a moment later
  await prisma.message.update({ where: { id: out.id }, data: { whatsappMessageId: id, status: "SENT" } });
  await delivering;
  const m = await prisma.message.findUnique({ where: { id: out.id } });
  check("an early 'failed' status still lands once the id is saved", m.status === "FAILED" && m.errorCode === 131026, `→ ${m.status} ${m.errorCode}`);
}

async function optOutWords() {
  console.log(`\n${B}opt-out words${RESET}`);
  const optOut = async (customerId) => prisma.customerOptOut.findUnique({ where: { customerId_whatsappNumberId: { customerId, whatsappNumberId: number.id } } });
  const from = phone();
  await deliver(inboundBody(from, { id: wamid("cancel"), type: "text", text: { body: "Cancel" } }));
  const c = await trackCustomer(from);
  check("'Cancel' is a normal message, not an opt-out", !(await optOut(c.id)));
  await deliver(inboundBody(from, { id: wamid("end"), type: "text", text: { body: "END" } }));
  check("'END' is a normal message too", !(await optOut(c.id)));
  await deliver(inboundBody(from, { id: wamid("stop"), type: "text", text: { body: "stop" } }));
  check("'STOP' opts them out of this line", (await optOut(c.id))?.source === "KEYWORD");
  await deliver(inboundBody(from, { id: wamid("start"), type: "text", text: { body: "START" } }));
  check("'START' after their own STOP opts them back in", !(await optOut(c.id)));

  const from2 = phone();
  await deliver(inboundBody(from2, { id: wamid("seed2"), type: "text", text: { body: "hi" } }));
  const c2 = await trackCustomer(from2);
  await prisma.customerOptOut.create({ data: { customerId: c2.id, whatsappNumberId: number.id, source: "MANUAL" } });
  await deliver(inboundBody(from2, { id: wamid("start2"), type: "text", text: { body: "start" } }));
  check("'START' does NOT lift an opt-out the team recorded", (await optOut(c2.id))?.source === "MANUAL");
}

async function replyCredit() {
  console.log(`\n${B}reply credit: latest campaign only${RESET}`);
  const admin = await prisma.user.create({ data: { username: "wh_admin", passwordHash: "x", role: "ADMIN" } });
  made.users.push(admin.id);
  const tpl = await prisma.template.create({ data: { wabaId: number.wabaId, name: "wh tpl", body: "Hi" } });
  made.templates.push(tpl.id);
  const from = phone();
  const customer = await prisma.customer.create({ data: { name: "WH Credit", phone: from } });
  made.customers.push(customer.id);
  const conv = await prisma.conversation.create({ data: { customerId: customer.id, whatsappNumberId: number.id } });
  const rec = {};
  for (const [key, daysAgo] of [["older", 2], ["newer", 1]]) {
    const camp = await prisma.campaign.create({ data: { name: `WH ${key}`, templateId: tpl.id, whatsappNumberId: number.id, createdById: admin.id, status: "COMPLETED" } });
    made.campaigns.push(camp.id);
    const sent = await prisma.message.create({ data: { conversationId: conv.id, senderType: "AGENT", content: "{}", messageType: "TEMPLATE", status: "SENT", whatsappMessageId: wamid(key) } });
    rec[key] = await prisma.campaignRecipient.create({ data: { campaignId: camp.id, customerId: customer.id, status: "SENT", messageId: sent.id, sentAt: new Date(Date.now() - daysAgo * DAY) } });
  }
  const id1 = wamid("reply1");
  await deliver(inboundBody(from, { id: id1, type: "text", text: { body: "interested" } }));
  const id2 = wamid("reply2");
  await deliver(inboundBody(from, { id: id2, type: "text", text: { body: "what time?" } }));
  const [m1, m2] = await Promise.all([id1, id2].map((w) => prisma.message.findFirst({ where: { whatsappMessageId: w } })));
  const [older, newer] = await Promise.all([rec.older, rec.newer].map((r) => prisma.campaignRecipient.findUnique({ where: { id: r.id } })));
  check("the first reply is credited to the newest campaign", m1.campaignRecipientId === rec.newer.id && newer.repliedAt !== null, `→ ${m1.campaignRecipientId}`);
  check("the second message is NOT credited to the older campaign", m2.campaignRecipientId === null && older.repliedAt === null, `→ ${m2.campaignRecipientId}, older replied ${older.repliedAt}`);
}

function errorHandling() {
  console.log(`\n${B}error handler${RESET}`);
  const logged = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...a) => logged.push(a.map(String).join(" "));
  console.warn = (...a) => logged.push(a.map(String).join(" "));
  const run = (err) => {
    const out = {};
    const res = { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; } };
    errorHandler(err, { method: "GET", originalUrl: "/api/x", user: { id: 1, username: "u" } }, res, () => {});
    return out;
  };
  try {
    const internal = run(new TypeError("Cannot read properties of undefined (reading 'secretColumn') at C:\\app\\x.js"));
    check("a code crash answers 500 without the internal text", internal.code === 500 && !/secretColumn|C:\\/.test(internal.body.message), internal.body.message);
    check("…with a reference the team can look up", /^[0-9a-f]{8}$/.test(internal.body.requestId) && internal.body.message.includes(internal.body.requestId));
    check("…and the full error is logged with that reference", logged.some((l) => l.includes(internal.body.requestId)) && logged.some((l) => l.includes("secretColumn")));

    const mine = run(new AppError("Campaign has no recipients", 400));
    check("a message written for users is kept", mine.code === 400 && mine.body.message === "Campaign has no recipients");

    const p2025 = Object.assign(new Error("Invalid `prisma.campaign.update()` invocation in C:\\app\\campaign.controller.js:42 — Record to update not found."), { code: "P2025" });
    const nf = run(p2025);
    check("a database 'not found' becomes a plain 404, no internals", nf.code === 404 && !/prisma|controller/i.test(nf.body.message), nf.body.message);

    const p2002 = Object.assign(new Error("Unique constraint failed on the fields: (`username`)"), { code: "P2002" });
    const dup = run(p2002);
    check("a database duplicate becomes a plain 409", dup.code === 409 && !/constraint|username/.test(dup.body.message), dup.body.message);

    const detailed = run(Object.assign(new Error("boom"), { details: { sql: "SELECT secret" } }));
    check("details from an internal error never reach the browser", !("details" in detailed.body));
    const appDetails = run(new AppError("Over the limit", 409, "OVER_MESSAGING_LIMIT", { needed: 60 }));
    check("details written for users still do", appDetails.body.details?.needed === 60 && appDetails.body.code === "OVER_MESSAGING_LIMIT");
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  await require("./support/noLiveBackend").requireNoLiveBackend();
  try {
    number = await prisma.whatsAppNumber.create({
      data: { label: "Webhook check", phoneNumberId: PNID, wabaId: WABA_MARK, tokenEnvKey: "WHATSAPP_TOKEN_WEBHOOKCHECK" },
    });
    made.numbers.push(number.id);
    numbers.invalidate();
    for (const s of [durability, recovery, statusRace, optOutWords, replyCredit, errorHandling]) {
      try {
        await s();
      } catch (err) {
        check(`${s.name} ran without crashing`, false, err.stack || err.message);
      }
    }
  } finally {
    const custs = await prisma.customer.findMany({ where: { phone: { startsWith: TAG } }, select: { id: true } });
    const customerIds = [...new Set([...made.customers, ...custs.map((c) => c.id)])];
    const convs = await prisma.conversation.findMany({ where: { OR: [{ customerId: { in: customerIds } }, { whatsappNumberId: { in: made.numbers } }] }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: made.campaigns } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.template.deleteMany({ where: { id: { in: made.templates } } });
    await prisma.customerOptOut.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetType: "conversation", targetId: { in: convIds } }, { targetType: "Customer", targetId: { in: customerIds } }] } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.webhookEvent.deleteMany({ where: { payload: { path: ["entry", "0", "id"], equals: WABA_MARK } } });
    await prisma.whatsAppNumber.deleteMany({ where: { id: { in: made.numbers } } });
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
