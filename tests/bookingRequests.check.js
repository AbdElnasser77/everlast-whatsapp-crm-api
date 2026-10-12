// Booking requests check: flow answers become a request; agents take, book
// (one or several appointments), or close requests with a reason; bookings
// are linked to the request and its campaign; the chat's outcome follows.
//
// Drives the REAL booking-request handlers, the chat-outcome handler and the
// supervision / campaign readers. Creates only its own tagged rows (two
// throwaway numbers, phones starting TAG, users named br_*) and deletes
// exactly those in a finally block.
//
//   npm run check:booking-requests

process.env.QUIET_HOURS_FORCE_ENV = "1";
process.env.QUIET_HOURS_START = "00:00";
process.env.QUIET_HOURS_END = "00:00";
process.env.APP_SETTINGS_IGNORE_SAVED = "1";
process.env.WHATSAPP_TOKEN_BOOKINGCHECK = "fake-token";

require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });
const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const br = require("../utils/bookingRequests");
const ctl = require("../modules/bookingRequests/bookingRequest.controller");
const outcomeCtl = require("../modules/conversations/outcome.controller");
const sup = require("../modules/supervision/supervision.controller");
const campaigns = require("../modules/campaigns/campaign.controller");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", B = "\x1b[1m";
const TAG = "999560";
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}
const made = { numbers: [], users: [], customers: [], templates: [], campaigns: [], flows: [] };
let ctx;
let seq = 0;

function call(handler, req) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { resolve({ code: this.code, body }); } };
    Promise.resolve(handler(req, res, (err) => resolve({ error: err }))).catch((err) => resolve({ error: err }));
  });
}
const req = (user, extra = {}, number = ctx.number) => ({ params: {}, query: {}, body: {}, user, numberId: number.id, number, ...extra });
const future = (days, hour = 16) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

async function chat(number = ctx.number) {
  const customer = await prisma.customer.create({ data: { name: `BR Patient ${++seq}`, phone: `${TAG}${String(seq).padStart(5, "0")}` } });
  made.customers.push(customer.id);
  return prisma.conversation.create({ data: { customerId: customer.id, whatsappNumberId: number.id, lastMessage: "hi", lastMessageAt: new Date(), lastSenderType: "CUSTOMER" } });
}
async function flowRun(conversation, answers, { status = "COMPLETED", campaignId = null } = {}) {
  return prisma.flowRun.create({ data: { flowId: ctx.flow.id, conversationId: conversation.id, customerId: conversation.customerId, status, campaignId, data: { answers } } });
}

// ── sections ────────────────────────────────────────────────────────────────

async function fromFlow() {
  console.log(`\n${B}requests from the booking flow${RESET}`);
  const c = await chat();
  const run = await flowRun(c, { offer: "Laser hair removal", preferred_date: "2026-10-20", contact_number: "0501234567" }, { campaignId: ctx.campaign.id });
  const r = await br.createFromFlowRun(run.id);
  check("a finished booking flow creates a NEW request", r && r.status === "NEW" && r.source === "FLOW" && r.flowRunId === run.id);
  check("…with what the patient asked for", r && r.requested.preferred_date === "2026-10-20" && r.requested.offer === "Laser hair removal");
  check("…linked to the campaign it came from", r && r.campaignId === ctx.campaign.id);
  const again = await br.createFromFlowRun(run.id);
  check("running it twice doesn't make a second request", again.id === r.id && (await prisma.bookingRequest.count({ where: { flowRunId: run.id } })) === 1);
  const browse = await flowRun(await chat(), { offer: "Facial" });
  check("a flow that collected no booking details creates nothing", (await br.createFromFlowRun(browse.id)) === null);
  return { conversation: c, request: r };
}

async function claimAndBook({ conversation, request }) {
  console.log(`\n${B}taking and booking a request${RESET}`);
  const { agent, agent2 } = ctx;
  const p = (id) => ({ params: { id: String(id) } });
  const c1 = await call(ctl.claim, req(agent, p(request.id)));
  check("an agent takes it: IN_PROGRESS, theirs", c1.body?.data?.status === "IN_PROGRESS" && c1.body.data.claimedBy?.id === agent.id);
  const c2 = await call(ctl.claim, req(agent2, p(request.id)));
  check("a colleague can't silently take it over", c2.error?.errorCode === "REQUEST_CLAIMED" && c2.error.details?.claimedBy?.id === agent.id, c2.error?.message || "");
  const c3 = await call(ctl.claim, req(agent2, { ...p(request.id), body: { force: true } }));
  check("…but can, when they confirm", c3.body?.data?.claimedBy?.id === agent2.id);

  const noService = await call(ctl.book, req(agent2, { ...p(request.id), body: { appointments: [{ service: "Laser", appointmentAt: future(2) }, { appointmentAt: future(2) }] } }));
  check("every appointment needs a service (the message says which)", noService.error?.statusCode === 400 && /appointment 2/.test(noService.error.message), noService.error?.message);
  const past = await call(ctl.book, req(agent2, { ...p(request.id), body: { appointments: [{ service: "Laser", appointmentAt: new Date(Date.now() - 3 * DAY).toISOString() }] } }));
  check("an appointment in the past is refused", past.error?.statusCode === 400);
  const tooMany = await call(ctl.book, req(agent2, { ...p(request.id), body: { appointments: Array.from({ length: 11 }, () => ({ service: "x", appointmentAt: future(2) })) } }));
  check("at most 10 at once", tooMany.error?.statusCode === 400);
  check("nothing was saved by the refused attempts", (await prisma.booking.count({ where: { requestId: request.id } })) === 0);

  const ok = await call(ctl.book, req(agent2, { ...p(request.id), body: { appointments: [
    { service: "Laser hair removal", appointmentAt: future(2, 13), doctor: "Dr. Sara", dok32Ref: "APT-5531" },
    { service: "Skin consultation", appointmentAt: future(2, 14), note: "same visit" },
  ] } }));
  const bookings = await prisma.booking.findMany({ where: { requestId: request.id }, orderBy: { appointmentAt: "asc" } });
  const conv = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  check("booking two appointments from one request saves both", ok.code === 200 && bookings.length === 2, ok.error?.message || "");
  check("…each with its details, the request and the campaign", bookings[0].doctor === "Dr. Sara" && bookings[0].dok32Ref === "APT-5531" && bookings.every((b) => b.campaignId === ctx.campaign.id && b.createdById === ctx.agent2.id));
  check("…the request is BOOKED, handled by the agent", ok.body.data.status === "BOOKED" && ok.body.data.handledBy?.id === agent2.id);
  check("…and the chat's outcome is Booked", conv.outcome === "BOOKED");

  const more = await call(ctl.book, req(agent2, { ...p(request.id), body: { appointments: [{ service: "Follow-up session", appointmentAt: future(30) }] } }));
  check("more can be added to a booked request later", more.code === 200 && (await prisma.booking.count({ where: { requestId: request.id } })) === 3);

  const close = await call(ctl.notBooked, req(agent2, { ...p(request.id), body: { reason: "PRICE" } }));
  check("a request with live appointments can't be closed as not booked", close.error?.errorCode === "REQUEST_HAS_BOOKINGS");

  for (const b of await prisma.booking.findMany({ where: { requestId: request.id } })) {
    await call(outcomeCtl.cancelBooking, req(agent2, { params: { id: String(conversation.id), bookingId: String(b.id) } }));
  }
  const afterCancel = await prisma.bookingRequest.findUnique({ where: { id: request.id } });
  check("cancelling all its appointments puts the request back in progress", afterCancel.status === "IN_PROGRESS");

  const noReason = await call(ctl.notBooked, req(agent2, { ...p(request.id), body: {} }));
  check("closing needs a reason", noReason.error?.statusCode === 400);
  const otherNoNote = await call(ctl.notBooked, req(agent2, { ...p(request.id), body: { reason: "OTHER" } }));
  check("'Other' needs a note", otherNoNote.error?.statusCode === 400);
  const closed = await call(ctl.notBooked, req(agent2, { ...p(request.id), body: { reason: "PRICE", note: "wants a discount" } }));
  check("closed as not booked, with the reason", closed.body?.data?.status === "NOT_BOOKED" && closed.body.data.notBookedReason === "PRICE");
  const bookClosed = await call(ctl.book, req(agent2, { ...p(request.id), body: { appointments: [{ service: "x", appointmentAt: future(3) }] } }));
  check("a closed request must be reopened before booking", bookClosed.error?.errorCode === "REQUEST_CLOSED");
  const reopened = await call(ctl.reopen, req(agent, p(request.id)));
  check("reopening puts it back in progress, with whoever reopened it", reopened.body?.data?.status === "IN_PROGRESS" && reopened.body.data.claimedBy?.id === agent.id && !reopened.body.data.notBookedReason);
}

async function fromChat() {
  console.log(`\n${B}requests from a normal chat${RESET}`);
  const { agent } = ctx;
  // A patient who got the campaign yesterday and then wrote in.
  const c = await chat();
  await prisma.campaignRecipient.create({ data: { campaignId: ctx.campaign.id, customerId: c.customerId, status: "SENT", sentAt: new Date(Date.now() - DAY) } });
  const created = await call(ctl.createForChat, req(agent, { params: { id: String(c.id) }, body: { service: "Teeth whitening", preferredDate: "next Monday" } }));
  check("an agent opens a request from a chat: in progress, theirs", created.code === 201 && created.body.data.status === "IN_PROGRESS" && created.body.data.claimedBy?.id === agent.id && created.body.data.source === "AGENT");
  check("…credited to the campaign the patient got this week", created.body.data.campaignId === ctx.campaign.id);

  // The chat's "Booked" outcome uses that same request — no second one.
  const booked = await call(outcomeCtl.setOutcome, req(agent, { params: { id: String(c.id) }, body: { outcome: "BOOKED", appointments: [{ service: "Teeth whitening", appointmentAt: future(5) }] } }));
  const requests = await prisma.bookingRequest.findMany({ where: { conversationId: c.id } });
  check("marking the chat Booked books the open request (no duplicate request)", booked.code === 200 && requests.length === 1 && requests[0].status === "BOOKED", booked.error?.message || `${requests.length} requests`);

  // Booked on a chat with no request at all: one is created for it.
  const c2 = await chat();
  const direct = await call(outcomeCtl.setOutcome, req(agent, { params: { id: String(c2.id) }, body: { outcome: "BOOKED", booking: { service: "Check-up", appointmentAt: future(4) } } }));
  const r2 = await prisma.bookingRequest.findMany({ where: { conversationId: c2.id }, include: { bookings: true } });
  check("Booked on a chat without a request creates one, booked", direct.code === 200 && r2.length === 1 && r2[0].status === "BOOKED" && r2[0].bookings.length === 1, direct.error?.message || "");
  const bad = await call(outcomeCtl.setOutcome, req(agent, { params: { id: String((await chat()).id) }, body: { outcome: "BOOKED", appointments: [{ appointmentAt: future(4) }] } }));
  check("an invalid Booked creates no stray request", bad.error?.statusCode === 400 && (await prisma.bookingRequest.count({ where: { conversation: { customer: { name: `BR Patient ${seq}` } } } })) === 0);
}

async function queuesAndReports() {
  console.log(`\n${B}queues and reports${RESET}`);
  const { agent, supervisor } = ctx;
  const fresh = await br.createFromFlowRun((await flowRun(await chat(), { preferred_date: "2026-10-22" })).id);
  const counts = await call(ctl.getCounts, req(agent));
  check("counts: new and in progress", counts.body?.data?.new >= 1 && counts.body.data.inProgress >= 1, JSON.stringify(counts.body?.data));
  const open = await call(ctl.listRequests, req(agent, { query: { status: "open" } }));
  check("the open queue lists new and in-progress requests, oldest first", open.body.data.some((r) => r.id === fresh.id) && open.body.data.every((r) => ["NEW", "IN_PROGRESS"].includes(r.status)));
  const mine = await call(ctl.listRequests, req(agent, { query: { status: "open", mine: "1" } }));
  check("'mine' only shows requests the agent has", mine.body.data.length >= 1 && mine.body.data.every((r) => r.claimedById === agent.id));

  // Another line's request is invisible here.
  const otherLine = await br.createFromFlowRun((await flowRun(await chat(ctx.number2), { preferred_date: "2026-10-25" })).id);
  const fromHere = await call(ctl.getRequest, req(agent, { params: { id: String(otherLine.id) } }));
  check("a request on another line can't be opened from this one", fromHere.error?.statusCode === 404);

  const ov = await call(sup.getOverview, req(supervisor, { query: { numberId: String(ctx.number.id) } }));
  check("Supervision counts open and not-picked-up requests", ov.body.data.kpis.bookingRequestsOpen >= 2 && ov.body.data.kpis.bookingRequestsNew >= 1, JSON.stringify(ov.body.data.kpis));
  const list = await call(sup.getConversations, req(supervisor, { query: { filter: "booking", numberId: String(ctx.number.id) } }));
  check("Supervision's booking tab lists chats with an open request", list.body.data.some((r) => r.id === fresh.conversationId && r.openRequest?.id === fresh.id));

  const camp = await call(campaigns.getCampaign, req(supervisor, { params: { id: String(ctx.campaign.id) } }));
  check("the campaign shows what it produced: bookings and requests", camp.body?.data?.bookedCount >= 1 && camp.body.data.bookingRequestsCount >= 2, `booked ${camp.body?.data?.bookedCount}, requests ${camp.body?.data?.bookingRequestsCount}`);
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const mk = async (username, role) => {
      const u = await prisma.user.create({ data: { username, name: username, passwordHash: "x", role } });
      made.users.push(u.id);
      return u;
    };
    const agent = await mk("br_agent", "AGENT");
    const agent2 = await mk("br_agent2", "AGENT");
    const supervisor = await mk("br_super", "SUPERVISOR");
    const number = await prisma.whatsAppNumber.create({ data: { label: "Booking check", phoneNumberId: "__booking_check_pnid__", wabaId: "waba_br", tokenEnvKey: "WHATSAPP_TOKEN_BOOKINGCHECK" } });
    const number2 = await prisma.whatsAppNumber.create({ data: { label: "Booking check B", phoneNumberId: "__booking_check_pnid_b__", wabaId: "waba_br", tokenEnvKey: "WHATSAPP_TOKEN_BOOKINGCHECK" } });
    made.numbers.push(number.id, number2.id);
    numbers.invalidate();
    const template = await prisma.template.create({ data: { wabaId: "waba_br", name: "br template", body: "Hi" } });
    made.templates.push(template.id);
    const campaign = await prisma.campaign.create({ data: { name: "BR Anniversary", templateId: template.id, whatsappNumberId: number.id, createdById: supervisor.id, status: "COMPLETED" } });
    made.campaigns.push(campaign.id);
    const flow = await prisma.flow.create({ data: { name: "BR booking flow", graph: { nodes: [], edges: [] }, createdById: supervisor.id } });
    made.flows.push(flow.id);
    ctx = { agent, agent2, supervisor, number, number2, campaign, flow };

    const first = await fromFlow();
    await claimAndBook(first);
    await fromChat();
    await queuesAndReports();
  } catch (err) {
    check("check ran without crashing", false, err.stack || err.message);
  } finally {
    const convs = await prisma.conversation.findMany({ where: { customerId: { in: made.customers } }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.booking.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.bookingRequest.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.flowRun.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.flow.deleteMany({ where: { id: { in: made.flows } } });
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: made.campaigns } } });
    await prisma.campaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.template.deleteMany({ where: { id: { in: made.templates } } });
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetType: "conversation", targetId: { in: convIds } }, { actorId: { in: made.users } }] } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: made.customers } } });
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
