// Supervisor role + Supervision page check.
//
// "Who is waiting" bookkeeping (patient writes → waiting; agent replies →
// not), the Supervision overview / chat lists / timeline, chat outcomes with
// bookings, chat notes, and what the SUPERVISOR role may and may not do.
//
// Drives the REAL webhook, the REAL send-message endpoint (Meta faked), and
// the REAL outcome / notes / supervision handlers. Creates only its own
// tagged rows (a throwaway number, phones starting TAG, users named sv_*) and
// deletes exactly those in a finally block.
//
//   npm run check:supervision

process.env.QUIET_HOURS_FORCE_ENV = "1";
process.env.QUIET_HOURS_START = "00:00"; // quiet hours off: every minute is working time
process.env.QUIET_HOURS_END = "00:00";
process.env.APP_SETTINGS_IGNORE_SAVED = "1";
process.env.WHATSAPP_TOKEN_SUPERVISIONCHECK = "fake-token";

const fakeMeta = require("./support/fakeMeta");
fakeMeta.install();
require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });

const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const { roleHasPermission } = require("../config/permissions");
const { receiveWhatsAppMessage } = require("../modules/webhooks/webhook.controller");
const { sendMessage } = require("../modules/messages/message.controller");
const outcomeCtl = require("../modules/conversations/outcome.controller");
const sup = require("../modules/supervision/supervision.controller");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m";
const TAG = "999559";
const PNID = "__supervision_check_pnid__";
const MIN = 60 * 1000;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}
const made = { numbers: [], users: [], templates: [], campaigns: [], flows: [] };
let ctx;
let seq = 0;
const phone = () => `${TAG}${String(++seq).padStart(5, "0")}`;

function call(handler, req) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { resolve({ code: this.code, body }); } };
    Promise.resolve(handler(req, res, (err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
  });
}
const req = (user, extra = {}) => ({ params: {}, query: {}, body: {}, user, numberId: ctx.number.id, number: ctx.number, ...extra });

async function patientWrites(from, text) {
  const body = { entry: [{ id: "waba_sv", changes: [{ field: "messages", value: {
    metadata: { phone_number_id: PNID },
    contacts: [{ wa_id: from, profile: { name: `SV ${from.slice(-3)}` } }],
    messages: [{ from, id: `wamid.sv.${Date.now()}.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] };
  await receiveWhatsAppMessage({ body }, { sendStatus: () => {} });
  const customer = await prisma.customer.findUnique({ where: { phone: from } });
  return prisma.conversation.findFirst({ where: { customerId: customer.id, whatsappNumberId: ctx.number.id } });
}
const conv = (id) => prisma.conversation.findUnique({ where: { id } });

// ── sections ────────────────────────────────────────────────────────────────

async function roles() {
  console.log(`\n${B}the SUPERVISOR role${RESET}`);
  const can = (p) => roleHasPermission("SUPERVISOR", p);
  check("works as an agent: reads, replies, assigns chats", ["conversation:read", "conversation:write", "conversation:assign", "message:send"].every(can));
  check("has the Supervision page", can("team:supervise"));
  check("can read campaign results", can("campaign:read"));
  check("can't create, send or control campaigns", !can("campaign:write") && !can("campaign:send") && !can("campaign:control"));
  check("can't open Settings or manage users", !can("settings:write") && !can("user:write") && !can("number:write"));
  check("agents don't get the Supervision page", !roleHasPermission("AGENT", "team:supervise"));
}

async function waitingBookkeeping() {
  console.log(`\n${B}who is waiting for a reply${RESET}`);
  const from = phone();
  const c1 = await patientWrites(from, "Hi, do you have slots tomorrow?");
  check("a patient's message starts the waiting clock", Boolean(c1.awaitingReplySince));
  const started = c1.awaitingReplySince.getTime();
  const c2 = await patientWrites(from, "anyone?");
  check("a second message doesn't restart it (waiting since the first)", c2.awaitingReplySince.getTime() === started);

  fakeMeta.reset();
  const sent = await call(sendMessage, req(ctx.agent, { body: { conversationId: c1.id, content: "Yes! 4pm works?" } }));
  const c3 = await conv(c1.id);
  check("an agent's reply stops it and records the reply time", !sent.error && c3.awaitingReplySince === null && Boolean(c3.lastAgentReplyAt),
    sent.error?.message || `waiting ${c3.awaitingReplySince}`);

  await patientWrites(from, "great");
  check("the patient writing again starts a new wait", Boolean((await conv(c1.id)).awaitingReplySince));
  return c1.id;
}

async function outcomes(conversationId) {
  console.log(`\n${B}chat outcomes and bookings${RESET}`);
  const { agent } = ctx;
  const p = { params: { id: String(conversationId) } };
  const noDate = await call(outcomeCtl.setOutcome, req(agent, { ...p, body: { outcome: "BOOKED", booking: {} } }));
  check("Booked needs an appointment date", noDate.error?.statusCode === 400, noDate.error?.message || "");
  const past = await call(outcomeCtl.setOutcome, req(agent, { ...p, body: { outcome: "BOOKED", booking: { appointmentAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() } } }));
  check("a past appointment is refused", past.error?.statusCode === 400, past.error?.message || "");
  const bogus = await call(outcomeCtl.setOutcome, req(agent, { ...p, body: { outcome: "MAYBE" } }));
  check("an unknown outcome is refused", bogus.error?.statusCode === 400);

  const at = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const ok = await call(outcomeCtl.setOutcome, req(agent, { ...p, body: { outcome: "BOOKED", booking: { appointmentAt: at.toISOString(), service: "Dental cleaning", note: "prefers Dr. Sara" } } }));
  const c = await conv(conversationId);
  const bookings = await prisma.booking.findMany({ where: { conversationId } });
  check("Booked: the chat is marked, by whom and when", ok.code === 200 && c.outcome === "BOOKED" && c.outcomeById === agent.id && Boolean(c.outcomeAt), ok.error?.message || "");
  check("…and the appointment is saved with its details", bookings.length === 1 && bookings[0].service === "Dental cleaning" && bookings[0].appointmentAt.getTime() === at.getTime() && bookings[0].createdById === agent.id);

  const cancel = await call(outcomeCtl.cancelBooking, req(agent, { params: { id: String(conversationId), bookingId: String(bookings[0].id) } }));
  const afterCancel = await conv(conversationId);
  const cancelled = await prisma.booking.findUnique({ where: { id: bookings[0].id } });
  check("cancelling keeps the booking as CANCELLED history", cancel.code === 200 && cancelled.status === "CANCELLED" && Boolean(cancelled.cancelledAt));
  check("…and with no live booking left, the chat's outcome clears", afterCancel.outcome === null);

  const noWhen = await call(outcomeCtl.setOutcome, req(agent, { ...p, body: { outcome: "FOLLOW_UP" } }));
  check("Follow up needs a date", noWhen.error?.statusCode === 400);
  const due = new Date(Date.now() - 5 * MIN); // already due
  await call(outcomeCtl.setOutcome, req(agent, { ...p, body: { outcome: "FOLLOW_UP", followUpAt: due.toISOString() } }));
  check("Follow up is saved with its date", (await conv(conversationId)).followUpAt?.getTime() === due.getTime());

  const hist = await prisma.auditLog.findMany({ where: { targetType: "conversation", targetId: conversationId, action: { startsWith: "conversation.outcome" } } });
  check("every outcome change is in the chat's history", hist.length >= 2, `${hist.length} entries`);
}

async function notes(conversationId) {
  console.log(`\n${B}chat notes${RESET}`);
  const { agent, agent2, supervisor } = ctx;
  const p = { params: { id: String(conversationId) } };
  const empty = await call(outcomeCtl.addNote, req(agent, { ...p, body: { body: "   " } }));
  check("an empty note is refused", empty.error?.statusCode === 400);
  const n1 = await call(outcomeCtl.addNote, req(agent, { ...p, body: { body: "Call her back at 5" } }));
  check("an agent adds a note", n1.code === 201 && n1.body.data.author.id === agent.id);
  const other = await call(outcomeCtl.deleteNote, req(agent2, { params: { id: String(conversationId), noteId: String(n1.body.data.id) } }));
  check("another agent can't delete it", other.error?.statusCode === 403);
  const bySup = await call(outcomeCtl.deleteNote, req(supervisor, { params: { id: String(conversationId), noteId: String(n1.body.data.id) } }));
  check("a supervisor can", bySup.code === 200);
  const n2 = await call(outcomeCtl.addNote, req(agent, { ...p, body: { body: "Interested in whitening too" } }));
  const own = await call(outcomeCtl.deleteNote, req(agent, { params: { id: String(conversationId), noteId: String(n2.body.data.id) } }));
  check("the author can delete their own", own.code === 200);
  await call(outcomeCtl.addNote, req(supervisor, { ...p, body: { body: "Priority patient" } }));
}

async function supervisionViews(bookedConvId) {
  console.log(`\n${B}the Supervision page${RESET}`);
  const { supervisor, agent } = ctx;
  const q = (query) => req(supervisor, { query: { numberId: String(ctx.number.id), ...query } });

  // A patient waiting 45 minutes, assigned to the agent; one waiting 5 minutes, unassigned.
  const long = await patientWrites(phone(), "Hello??");
  await prisma.conversation.update({ where: { id: long.id }, data: { awaitingReplySince: new Date(Date.now() - 45 * MIN), assignedAgentId: agent.id } });
  const short = await patientWrites(phone(), "hi");
  await prisma.conversation.update({ where: { id: short.id }, data: { awaitingReplySince: new Date(Date.now() - 5 * MIN) } });

  // A flow run that collected a booking request; one that stopped halfway.
  const flow = await prisma.flow.create({ data: { name: "SV booking flow", graph: { nodes: [], edges: [] }, createdById: supervisor.id } });
  made.flows.push(flow.id);
  const reqConv = await patientWrites(phone(), "I'd like to book");
  const dropConv = await patientWrites(phone(), "offers?");
  if (flow) {
    await prisma.flowRun.create({ data: { flowId: flow.id, conversationId: reqConv.id, customerId: reqConv.customerId, status: "COMPLETED", data: { answers: { preferred_date: "2026-10-20", contact_number: "0501234567" } } } });
    await prisma.flowRun.create({ data: { flowId: flow.id, conversationId: dropConv.id, customerId: dropConv.customerId, status: "EXPIRED", data: { answers: {} } } });
  }

  const ov = await call(sup.getOverview, q({}));
  const k = ov.body?.data?.kpis || {};
  check("overview counts who is waiting and who is over 30 min", k.waiting >= 2 && k.waitingOverSla >= 1 && k.longestWaitMinutes >= 45, JSON.stringify(k));
  check("…unassigned waiting is counted", k.unassignedWaiting >= 1);
  const boardIds = ov.body.data.agents.map((a) => a.id);
  check("the board leaves out the supervisor looking at it", !boardIds.includes(supervisor.id));
  check("…and leaves out admins", ov.body.data.agents.every((a) => a.role !== "ADMIN"));
  const asAdmin = await call(sup.getOverview, req(ctx.admin, { query: { numberId: String(ctx.number.id) } }));
  check("an admin's board shows the supervisor, but not the admin", asAdmin.body.data.agents.some((a) => a.id === supervisor.id) && !asAdmin.body.data.agents.some((a) => a.id === ctx.admin.id));
  const me = ov.body.data.agents.find((a) => a.id === agent.id);
  check("agent board: their last reply time", me && Boolean(me.lastReplyAt));

  const feed = await call(sup.getActivity, q({ limit: "50" }));
  const reply = feed.body?.data?.find((i) => i.type === "agent_message" && i.actor?.id === agent.id);
  check("live feed: an agent's reply, with what they said", reply && /4pm/.test(reply.text || ""), reply ? reply.text : JSON.stringify(feed.body?.data?.slice(0, 2)));
  check("live feed: patients writing in", feed.body.data.some((i) => i.type === "patient_message"));
  check("live feed: outcome changes", feed.body.data.some((i) => i.type === "conversation.outcome_set"));
  const newest = feed.body.data[0].at;
  const none = await call(sup.getActivity, q({ after: new Date(newest).toISOString() }));
  check("polling with 'after' returns only what's new", none.body.data.length === 0, `${none.body.data.length} items`);
  await patientWrites(phone(), "just now");
  const fresh = await call(sup.getActivity, q({ after: new Date(newest).toISOString() }));
  check("…and picks up a message that just arrived", fresh.body.data.some((i) => i.type === "patient_message" && i.text === "just now"));
  check("agent board: open chats, waiting over 30 min, replies today", me && me.openChats >= 1 && me.waitingOverSla >= 1 && me.repliesToday >= 1, JSON.stringify(me));
  check("agent board: average response time measured", me && me.avgResponseMinutes !== null, `avg ${me && me.avgResponseMinutes}m`);
  if (flow) {
    check("overview counts open booking requests and halfway drop-offs", k.bookingRequestsOpen >= 1 && k.droppedHalfwayToday >= 1, `requests ${k.bookingRequestsOpen}, dropped ${k.droppedHalfwayToday}`);
  }

  const waiting = await call(sup.getConversations, q({ filter: "waiting" }));
  const rows = waiting.body?.data || [];
  const iLong = rows.findIndex((r) => r.id === long.id);
  const iShort = rows.findIndex((r) => r.id === short.id);
  check("'waiting' lists the newest message first", iLong !== -1 && iShort !== -1 && iShort < iLong, `positions ${iShort}, ${iLong}`);
  check("…flags the one over 30 minutes", rows[iLong]?.overSla === true && rows[iShort]?.overSla === false, `${rows[iLong]?.waitingMinutes}m / ${rows[iShort]?.waitingMinutes}m`);
  const mine = await call(sup.getConversations, q({ filter: "waiting", agentId: String(agent.id) }));
  check("filter by agent", mine.body.data.every((r) => r.assignedAgent?.id === agent.id) && mine.body.data.some((r) => r.id === long.id));
  const unassigned = await call(sup.getConversations, q({ filter: "waiting", agentId: "unassigned" }));
  check("filter unassigned", unassigned.body.data.every((r) => !r.assignedAgent) && unassigned.body.data.some((r) => r.id === short.id));

  if (flow) {
    const booking = await call(sup.getConversations, q({ filter: "booking" }));
    check("'booking requests' shows the chat whose flow collected a date", booking.body.data.some((r) => r.id === reqConv.id && r.flow?.bookingRequested));
    const halfway = await call(sup.getConversations, q({ filter: "halfway" }));
    check("'dropped halfway' shows the expired flow", halfway.body.data.some((r) => r.id === dropConv.id && r.flow?.droppedHalfway));
  }
  // A patient who wrote two days ago and was never answered has "gone cold".
  const cold = await patientWrites(phone(), "hello? (2 days ago)");
  await prisma.conversation.update({ where: { id: cold.id }, data: { awaitingReplySince: new Date(Date.now() - 48 * 60 * MIN), lastMessageAt: new Date(Date.now() - 48 * 60 * MIN) } });
  const w2 = await call(sup.getConversations, q({ filter: "waiting" }));
  const c2 = await call(sup.getConversations, q({ filter: "cold" }));
  check("a wait older than a day is not in 'waiting'…", !w2.body.data.some((r) => r.id === cold.id));
  check("…it's in 'gone cold'", c2.body.data.some((r) => r.id === cold.id));
  const ov2 = await call(sup.getOverview, q({}));
  // The Waiting count is exactly the Waiting tab (patients) — the cold one isn't in it.
  check("…and counted as gone cold, not as waiting", ov2.body.data.kpis.goneCold >= 1 && ov2.body.data.kpis.waiting === w2.body.pagination.total, JSON.stringify(ov2.body.data.kpis) + ` / tab ${w2.body.pagination.total}`);

  // The same patient on a second line: one row, the other chat attached.
  const second = await prisma.whatsAppNumber.create({ data: { label: "Supervision check B", phoneNumberId: PNID + "_b", wabaId: "waba_sv", tokenEnvKey: "WHATSAPP_TOKEN_SUPERVISIONCHECK" } });
  made.numbers.push(second.id);
  const twin = await prisma.conversation.create({ data: { customerId: long.customerId, whatsappNumberId: second.id, lastMessage: "also here", lastMessageAt: new Date(Date.now() - 60 * MIN), lastSenderType: "CUSTOMER", awaitingReplySince: new Date(Date.now() - 60 * MIN) } });
  const all = await call(sup.getConversations, req(supervisor, { query: { filter: "waiting" } }));
  const rowsFor = all.body.data.filter((r) => r.customer.id === long.customerId);
  check("a patient on two lines is ONE row", rowsFor.length === 1, `${rowsFor.length} rows`);
  check("…with the other line's chat attached", rowsFor[0]?.otherChats?.some((o) => o.id === twin.id && o.whatsappNumber.id === second.id));
  const tl2 = await call(sup.getConversationTimeline, req(supervisor, { params: { id: String(long.id) } }));
  check("…and the detail pane lists their chat on the other line", tl2.body.data.otherChats.some((o) => o.id === twin.id));

  const fu = await call(sup.getConversations, q({ filter: "follow_up" }));
  const fuRow = fu.body.data.find((r) => r.id === bookedConvId);
  check("'follow-ups' shows the chat, flagged overdue", fuRow && fuRow.followUpOverdue === true);

  const tl = await call(sup.getConversationTimeline, req(supervisor, { params: { id: String(bookedConvId) } }));
  const t = tl.body?.data;
  check("timeline: latest messages with who sent them", t && t.messages.length >= 4 && t.messages.some((m) => m.senderType === "AGENT" && m.sender?.id === agent.id));
  check("timeline: each wait and how long the reply took", t && t.waits.some((w) => w.repliedBy && w.minutes >= 0) && t.waits.some((w) => w.stillWaiting === false));
  check("timeline: bookings (incl. cancelled), notes and history", t && t.bookings.length >= 1 && t.notes.length >= 1 && t.history.some((h) => h.action === "conversation.outcome_set"));

  const b = await call(sup.getBookings, q({ status: "all" }));
  check("bookings list includes the patient's appointment", b.body?.data?.some((x) => x.conversationId === bookedConvId));
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const mk = async (username, role) => {
      const u = await prisma.user.create({ data: { username, name: username, passwordHash: "x", role } });
      made.users.push(u.id);
      return u;
    };
    const agent = await mk("sv_agent", "AGENT");
    const agent2 = await mk("sv_agent2", "AGENT");
    const supervisor = await mk("sv_super", "SUPERVISOR");
    const admin = await mk("sv_admin", "ADMIN");
    const number = await prisma.whatsAppNumber.create({ data: { label: "Supervision check", phoneNumberId: PNID, wabaId: "waba_sv", tokenEnvKey: "WHATSAPP_TOKEN_SUPERVISIONCHECK" } });
    made.numbers.push(number.id);
    numbers.invalidate();
    ctx = { agent, agent2, supervisor, admin, number };

    await roles();
    const convId = await waitingBookkeeping();
    await outcomes(convId);
    await notes(convId);
    await supervisionViews(convId);
  } catch (err) {
    check("check ran without crashing", false, err.stack || err.message);
  } finally {
    const custs = await prisma.customer.findMany({ where: { phone: { startsWith: TAG } }, select: { id: true } });
    const customerIds = custs.map((c) => c.id);
    const convs = await prisma.conversation.findMany({ where: { OR: [{ customerId: { in: customerIds } }, { whatsappNumberId: { in: made.numbers } }] }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.flowRun.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.flow.deleteMany({ where: { id: { in: made.flows } } });
    await prisma.booking.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.conversationNote.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetType: "conversation", targetId: { in: convIds } }, { actorId: { in: made.users } }] } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.customerOptOut.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.webhookEvent.deleteMany({ where: { payload: { path: ["entry", "0", "id"], equals: "waba_sv" } } });
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
