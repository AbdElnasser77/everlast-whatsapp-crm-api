// Multi-number scoping check.
//
// The question this answers is the one the whole feature rests on: with two
// numbers configured, does a query scoped to one ever see the other's data?
// A handler that forgets its number filter is the defining bug of this feature,
// and it is invisible until a second number exists — which is exactly why this
// seeds two.
//
// It also proves the constraint change that made multi-number possible at all:
// one customer holding two independent conversations, which the old
// `Conversation.customerId @unique` made impossible.
//
// Refuses to run unless the Customer table is empty, so it can never be pointed
// at real patient data. Cleanup runs in a finally block.
//
//   npm run check:scoping

require("dotenv").config({ path: __dirname + "/../config.env" });
const prisma = require("../config/prisma");
const { buildCustomerWhere } = require("../utils/segmentFilter");
const { conversationWhere, messageWhere } = require("../modules/stats/stats.scope");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", Y = "\x1b[33m";
const TAG = "999111"; // every seeded phone starts here, so cleanup is exact
const PNID_A = "__test_pnid_A__";
const PNID_B = "__test_pnid_B__";

let pass = 0, fail = 0;

function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`${G}PASS${RESET} ${name}  ${D}${detail}${RESET}`); }
  else { fail++; console.log(`${R}FAIL${RESET} ${name}  ${D}${detail}${RESET}`); }
}

// Mimics what resolveNumber puts on a request, so the helpers are exercised
// exactly as the controllers use them.
const reqFor = (numberId) => ({ numberId, numberScope: "NUMBER" });
const reqAll = { numberId: null, numberScope: "ALL" };

async function main() {
  const existing = await prisma.customer.count();
  if (existing > 0) {
    console.log(`${Y}Refusing to run: Customer table is not empty (${existing} rows).${RESET}`);
    console.log(`${D}This check seeds and deletes data; it only runs against an empty database.${RESET}`);
    process.exit(0);
  }

  let numA, numB, customer;

  try {
    numA = await prisma.whatsAppNumber.create({
      data: {
        label: "Test Clinic", phoneNumberId: PNID_A, wabaId: "waba_A",
        tokenEnvKey: "WHATSAPP_TOKEN_TEST_A", isActive: true,
      },
    });
    numB = await prisma.whatsAppNumber.create({
      data: {
        label: "Test Marketing", phoneNumberId: PNID_B, wabaId: "waba_B",
        tokenEnvKey: "WHATSAPP_TOKEN_TEST_B", isActive: true,
      },
    });

    customer = await prisma.customer.create({
      data: { name: "Scoping Test", phone: `${TAG}0001` },
    });

    // ── The constraint that used to be impossible ──────────────────────────
    const convA = await prisma.conversation.create({
      data: { customerId: customer.id, whatsappNumberId: numA.id, status: "OPEN" },
    });
    const convB = await prisma.conversation.create({
      data: { customerId: customer.id, whatsappNumberId: numB.id, status: "OPEN" },
    });
    check(
      "one customer can hold a conversation on each number",
      convA.id !== convB.id,
      `→ conv ${convA.id} on A, conv ${convB.id} on B`,
    );

    let rejected = false;
    try {
      await prisma.conversation.create({
        data: { customerId: customer.id, whatsappNumberId: numA.id, status: "OPEN" },
      });
    } catch { rejected = true; }
    check("a SECOND conversation on the same number is still rejected", rejected,
      "→ @@unique([customerId, whatsappNumberId]) holds");

    await prisma.message.create({
      data: { conversationId: convA.id, senderType: "CUSTOMER", content: "hello from A", messageType: "TEXT" },
    });
    await prisma.message.create({
      data: { conversationId: convB.id, senderType: "CUSTOMER", content: "hello from B", messageType: "TEXT" },
    });

    // ── Conversation scoping ───────────────────────────────────────────────
    const convCountA = await prisma.conversation.count({ where: conversationWhere(reqFor(numA.id)) });
    const convCountB = await prisma.conversation.count({ where: conversationWhere(reqFor(numB.id)) });
    check("conversation list is scoped to its number", convCountA === 1 && convCountB === 1,
      `→ A=${convCountA}, B=${convCountB}`);

    const convAll = await prisma.conversation.count({ where: conversationWhere(reqAll) });
    check("scope=ALL sees both numbers", convAll === 2, `→ ${convAll}`);

    // ── Message scoping (via the conversation relation) ────────────────────
    const msgA = await prisma.message.findMany({ where: messageWhere(reqFor(numA.id)) });
    const msgB = await prisma.message.findMany({ where: messageWhere(reqFor(numB.id)) });
    check("messages are scoped through their conversation",
      msgA.length === 1 && msgB.length === 1 && msgA[0].content === "hello from A",
      `→ A=${msgA.length} ("${msgA[0]?.content}"), B=${msgB.length}`);

    // ── Per-number opt-out ─────────────────────────────────────────────────
    await prisma.customerOptOut.create({
      data: { customerId: customer.id, whatsappNumberId: numB.id, source: "KEYWORD" },
    });

    const reachableOnA = await prisma.customer.count({
      where: await buildCustomerWhere({}, { excludeOptedOut: true, whatsappNumberId: numA.id }),
    });
    const reachableOnB = await prisma.customer.count({
      where: await buildCustomerWhere({}, { excludeOptedOut: true, whatsappNumberId: numB.id }),
    });
    check("STOP on one number does not silence the other",
      reachableOnA === 1 && reachableOnB === 0,
      `→ reachable on A=${reachableOnA}, on B=${reachableOnB}`);

    // ── Segment rules are number-aware ─────────────────────────────────────
    await prisma.conversation.update({
      where: { id: convA.id },
      data: { lastCustomerMessageAt: new Date() },
    });

    const chattedOnA = await prisma.customer.count({
      where: await buildCustomerWhere(
        { match: "ALL", rules: [{ field: "lastInboundAt", op: "in_last_days", value: 7 }] },
        { whatsappNumberId: numA.id },
      ),
    });
    const chattedOnB = await prisma.customer.count({
      where: await buildCustomerWhere(
        { match: "ALL", rules: [{ field: "lastInboundAt", op: "in_last_days", value: 7 }] },
        { whatsappNumberId: numB.id },
      ),
    });
    check("\"messaged in last 7 days\" is scoped to the active number",
      chattedOnA === 1 && chattedOnB === 0,
      `→ recent on A=${chattedOnA}, on B=${chattedOnB}`);

    const chattedAnywhere = await prisma.customer.count({
      where: await buildCustomerWhere(
        { match: "ALL", rules: [{ field: "lastInboundAt", op: "in_last_days", value: 7, scope: "ANY" }] },
        { whatsappNumberId: numB.id },
      ),
    });
    check("a rule can opt into scope: ANY", chattedAnywhere === 1,
      `→ recent on any number, asked from B=${chattedAnywhere}`);

    // ── Lapsed must still include never-messaged ──────────────────────────
    const lapsedOnB = await prisma.customer.count({
      where: await buildCustomerWhere(
        { match: "ALL", rules: [{ field: "lastInboundAt", op: "older_than_days", value: 7 }] },
        { whatsappNumberId: numB.id },
      ),
    });
    check("lapsed on B includes a customer who only ever wrote to A", lapsedOnB === 1,
      `→ ${lapsedOnB}`);
  } finally {
    // Ordered by FK dependency; each is a no-op if the step above never ran.
    await prisma.message.deleteMany({ where: { conversation: { customer: { phone: { startsWith: TAG } } } } });
    await prisma.customerOptOut.deleteMany({ where: { customer: { phone: { startsWith: TAG } } } });
    await prisma.conversation.deleteMany({ where: { customer: { phone: { startsWith: TAG } } } });
    await prisma.customer.deleteMany({ where: { phone: { startsWith: TAG } } });
    await prisma.whatsAppNumber.deleteMany({ where: { phoneNumberId: { in: [PNID_A, PNID_B] } } });
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
