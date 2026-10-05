// Inbox workflow check: campaign-reply attribution, template button taps,
// reopening resolved chats, "replying claims", who is assignable, and the
// 24-hour window rule.
//
// Drives the REAL webhook handler (receiveWhatsAppMessage) with Meta-shaped
// payloads, so it tests what production runs rather than a copy of the logic.
//
// Safe to run against a database with real patients: it creates only its own
// tagged rows — two throwaway WhatsApp numbers, phones starting TAG, users
// named ic_* — records every id it creates, and deletes exactly those in a
// finally block. It never bulk-deletes by pattern outside those ids.
//
//   npm run check:inbox

require("dotenv").config({ path: __dirname + "/../config.env", quiet: true });
const prisma = require("../config/prisma");
const numbers = require("../utils/whatsappNumbers");
const { receiveWhatsAppMessage } = require("../modules/webhooks/webhook.controller");
const { claimIfUnassigned, isAssignable } = require("../utils/conversationAssignment");
const { windowState } = require("../utils/messagingWindow");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m";
const TAG = "999555";
const PNID_A = "__inbox_check_pnid_a__";
const PNID_B = "__inbox_check_pnid_b__";
const DAY = 24 * 60 * 60 * 1000;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}

let seq = 0;
// Feed one inbound message through the real webhook handler and wait for it.
async function inbound(pnid, phone, msg) {
  const body = {
    entry: [{ id: "waba_inbox_check", changes: [{ value: {
      metadata: { phone_number_id: pnid },
      contacts: [{ wa_id: phone, profile: { name: `Check ${phone.slice(-2)}` } }],
      messages: [{ from: phone, id: `wamid.inboxcheck.${Date.now()}.${++seq}`, ...msg }],
    } }] }],
  };
  await receiveWhatsAppMessage({ body }, { sendStatus: () => {} });
  return prisma.message.findFirst({
    where: { conversation: { customer: { phone } }, senderType: "CUSTOMER" },
    orderBy: { id: "desc" },
    include: { conversation: true },
  });
}

async function main() {
  const made = { numbers: [], customers: [], users: [], templates: [], campaigns: [] };

  try {
    // ── fixtures ────────────────────────────────────────────────────────────
    const author = await prisma.user.create({ data: { username: "ic_author", passwordHash: "x", role: "ADMIN" } });
    made.users.push(author.id);
    const numA = await prisma.whatsAppNumber.create({ data: { label: "Inbox check A", phoneNumberId: PNID_A, wabaId: "waba_ic_a", tokenEnvKey: "WHATSAPP_ACCESS_TOKEN" } });
    const numB = await prisma.whatsAppNumber.create({ data: { label: "Inbox check B", phoneNumberId: PNID_B, wabaId: "waba_ic_b", tokenEnvKey: "WHATSAPP_ACCESS_TOKEN" } });
    made.numbers.push(numA.id, numB.id);
    numbers.invalidate(); // the webhook resolves numbers through this cache

    const tpl = await prisma.template.create({ data: { wabaId: numA.wabaId, name: "ic template", body: "Book your visit" } });
    made.templates.push(tpl.id);
    const campaign = await prisma.campaign.create({ data: { name: "IC campaign", templateId: tpl.id, whatsappNumberId: numA.id, createdById: author.id, status: "COMPLETED" } });
    made.campaigns.push(campaign.id);

    // One customer per scenario, each already sent the campaign on number A
    // `daysAgo` days ago, via a real sent Message with its own WhatsApp id.
    const recipients = {};
    for (const [key, daysAgo] of [["quote", 2], ["window", 3], ["old", 8], ["other", 1]]) {
      const phone = `${TAG}${String(Object.keys(recipients).length).padStart(4, "0")}`;
      const customer = await prisma.customer.create({ data: { name: `IC ${key}`, phone } });
      made.customers.push(customer.id);
      const conv = await prisma.conversation.create({ data: { customerId: customer.id, whatsappNumberId: numA.id } });
      const sent = await prisma.message.create({ data: {
        conversationId: conv.id, senderType: "AGENT", content: "{}", messageType: "TEMPLATE", status: "SENT",
        whatsappMessageId: `wamid.ic.campaign.${key}`,
      } });
      const r = await prisma.campaignRecipient.create({ data: {
        campaignId: campaign.id, customerId: customer.id, status: "SENT",
        messageId: sent.id, sentAt: new Date(Date.now() - daysAgo * DAY),
      } });
      recipients[key] = { phone, customer, conv, recipient: r };
    }

    // ── template button taps ────────────────────────────────────────────────
    const tap = await inbound(PNID_A, recipients.quote.phone, {
      type: "button",
      button: { text: "Book now", payload: "BOOK" },
      context: { id: "wamid.ic.campaign.quote" },
    });
    check("a template button tap is saved with its label",
      tap && tap.content === "Book now" && tap.messageType === "TEXT", `→ ${JSON.stringify(tap && tap.content)}`);

    // ── attribution ─────────────────────────────────────────────────────────
    check("a quoted/button reply links to its campaign exactly",
      tap && tap.campaignRecipientId === recipients.quote.recipient.id, `→ campaignRecipientId ${tap && tap.campaignRecipientId}`);

    const typed = await inbound(PNID_A, recipients.window.phone, { type: "text", text: { body: "yes please" } });
    check("a typed reply within 7 days links to the campaign",
      typed && typed.campaignRecipientId === recipients.window.recipient.id, `→ ${typed && typed.campaignRecipientId}`);

    const repliedAt = (await prisma.campaignRecipient.findUnique({ where: { id: recipients.window.recipient.id } })).repliedAt;
    check("…and marks the recipient as replied", Boolean(repliedAt));

    const second = await inbound(PNID_A, recipients.window.phone, { type: "text", text: { body: "also, what time?" } });
    const repliedAfter = (await prisma.campaignRecipient.findUnique({ where: { id: recipients.window.recipient.id } })).repliedAt;
    check("only the FIRST reply links; later messages are normal conversation",
      second && second.campaignRecipientId === null && repliedAfter.getTime() === repliedAt.getTime(),
      `→ second linked: ${second && second.campaignRecipientId}`);

    const late = await inbound(PNID_A, recipients.old.phone, { type: "text", text: { body: "hello" } });
    check("a reply more than 7 days after the campaign does not link",
      late && late.campaignRecipientId === null, `→ ${late && late.campaignRecipientId}`);

    const elsewhere = await inbound(PNID_B, recipients.other.phone, { type: "text", text: { body: "hi from the other line" } });
    check("a message on a DIFFERENT number never links to this number's campaign",
      elsewhere && elsewhere.campaignRecipientId === null, `→ ${elsewhere && elsewhere.campaignRecipientId}`);

    // ── reopen on reply ─────────────────────────────────────────────────────
    await prisma.conversation.update({ where: { id: recipients.old.conv.id }, data: { status: "RESOLVED" } });
    await inbound(PNID_A, recipients.old.phone, { type: "text", text: { body: "one more question" } });
    const reopened = await prisma.conversation.findUnique({ where: { id: recipients.old.conv.id } });
    check("a message to a Resolved chat reopens it", reopened.status === "OPEN", `→ ${reopened.status}`);

    // ── who is assignable ───────────────────────────────────────────────────
    const agentA = await prisma.user.create({ data: { username: "ic_agent_a", passwordHash: "x", role: "AGENT" } });
    const agentB = await prisma.user.create({ data: { username: "ic_agent_b", passwordHash: "x", role: "AGENT" } });
    const inactive = await prisma.user.create({ data: { username: "ic_inactive", passwordHash: "x", role: "AGENT", isActive: false } });
    const marketer = await prisma.user.create({ data: { username: "ic_marketing", passwordHash: "x", role: "MARKETING" } });
    made.users.push(agentA.id, agentB.id, inactive.id, marketer.id);
    check("an active agent is assignable", isAssignable(agentA));
    check("a deactivated account is not assignable", !isAssignable(inactive));
    check("a marketing user (read-only inbox) is not assignable", !isAssignable(marketer));

    // ── replying claims: two agents at the same moment ──────────────────────
    const convId = recipients.window.conv.id;
    await prisma.conversation.update({ where: { id: convId }, data: { assignedAgentId: null } });
    const [claimA, claimB] = await Promise.all([
      claimIfUnassigned({ conversationId: convId, numberId: numA.id, user: agentA }),
      claimIfUnassigned({ conversationId: convId, numberId: numA.id, user: agentB }),
    ]);
    const owner = (await prisma.conversation.findUnique({ where: { id: convId } })).assignedAgentId;
    const winner = claimA ? agentA.id : claimB ? agentB.id : null;
    check("two simultaneous replies: exactly one claims, and it keeps it",
      (claimA !== claimB) && owner === winner, `→ A:${claimA} B:${claimB} owner:${owner}`);

    const again = await claimIfUnassigned({ conversationId: convId, numberId: numA.id, user: claimA ? agentB : agentA });
    check("replying to an already-owned chat does not take it", !again);

    // ── the 24-hour window ──────────────────────────────────────────────────
    const now = Date.now();
    check("never messaged = window CLOSED", windowState(null, now).open === false);
    check("last message 23h ago = open", windowState(new Date(now - 23 * 60 * 60 * 1000), now).open === true);
    check("last message 25h ago = closed", windowState(new Date(now - 25 * 60 * 60 * 1000), now).open === false);
  } finally {
    const customers = await prisma.customer.findMany({ where: { phone: { startsWith: TAG } }, select: { id: true } });
    const customerIds = [...new Set([...made.customers, ...customers.map((c) => c.id)])];
    const convs = await prisma.conversation.findMany({ where: { customerId: { in: customerIds } }, select: { id: true } });
    const convIds = convs.map((c) => c.id);
    await prisma.message.deleteMany({ where: { conversationId: { in: convIds } } });
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: made.campaigns } } });
    await prisma.campaign.deleteMany({ where: { id: { in: made.campaigns } } });
    await prisma.template.deleteMany({ where: { id: { in: made.templates } } });
    await prisma.customerOptOut.deleteMany({ where: { customerId: { in: customerIds } } });
    await prisma.auditLog.deleteMany({ where: { targetType: "conversation", targetId: { in: convIds } } });
    await prisma.conversation.deleteMany({ where: { id: { in: convIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
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
