// Segmentation engine check with a known fixture.
//
// The read-only sibling (segments.check.js) proves the compiler's invariants
// hold against whatever data exists. This one proves it counts the RIGHT
// rows: it seeds a small, fully-known population, asserts exact expected
// numbers for each operator, and deletes everything it created.
//
// Refuses to run unless the Customer table is empty, so it can never be
// pointed at real patient data. Cleanup runs in a finally block.
//
//   npm run check:segments:fixture

require("dotenv").config({ path: __dirname + "/../config.env" });
const prisma = require("../config/prisma");
const { buildCustomerWhere, resolveMemberIds } = require("../utils/segmentFilter");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m", Y = "\x1b[33m";
const TAG = "999000"; // every seeded phone starts here, so cleanup is exact
const FIXTURE_PNID = "__fixture_pnid__";

// Conversations now belong to a number, so the fixture needs one. It is created
// and torn down with the rest of the fixture rather than reusing a real row, so
// the check stays self-contained and cannot disturb a configured number.
let fixtureNumberId = null;

let pass = 0, fail = 0;

function iso(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d));
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

// Ages are computed from "now", so the fixture states a birth year relative to
// the current year — otherwise the expected counts would rot every January.
const YEAR = new Date().getUTCFullYear();

const PEOPLE = [
  // name              gender    bornYearsAgo  departments            tags        joinedDaysAgo  optedOut  lastInboundDaysAgo
  ["Amira Hassan",     "FEMALE", 28, ["Dermatology"],                ["VIP"],      20,   false,  5],
  ["Layla Mansour",    "FEMALE", 34, ["Dermatology", "Laser"],       ["VIP"],      45,   false,  90],
  ["Noor Khalid",      "FEMALE", 41, ["Laser"],                      [],           400,  false,  null],
  ["Sara Ibrahim",     "FEMALE", 52, ["Nutrition"],                  ["lead"],     10,   true,   2],
  ["Huda Farouk",      "FEMALE", 67, ["Dermatology"],                [],           700,  false,  200],
  ["Omar Zaki",        "MALE",   31, ["Laser"],                      ["VIP"],      33,   false,  40],
  ["Karim Adel",       "MALE",   45, ["Nutrition", "Dermatology"],   ["lead"],     120,  false,  null],
  ["Yusuf Nabil",      "MALE",   19, [],                             [],           5,    false,  1],
  ["Tarek Sami",       "MALE",   58, ["Nutrition"],                  [],           900,  true,   null],
  ["Hani Rashad",      "MALE",   38, ["Dermatology"],                ["lead"],     60,   false,  120],
];

// Birthday months are assigned deterministically so the month filter has
// something specific to find: indexes 0..9 → months 1..10.
const BIRTH_MONTH = (i) => i + 1;

async function check(label, expected, fn) {
  try {
    const actual = await fn();
    if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
    console.log(`${G}PASS${RESET} ${label} ${D}= ${actual}${RESET}`);
    pass++;
  } catch (err) {
    console.log(`${R}FAIL${RESET} ${label}\n     ${err.message}`);
    fail++;
  }
}

async function count(rules, opts = {}, match = "ALL") {
  // Conversation rules default to the ACTIVE number, so every expectation here
  // is asked about the fixture's own number. Without this the conversation-based
  // checks would silently compile to "any number" and stop testing the scoping.
  const where = await buildCustomerWhere({ match, rules }, { whatsappNumberId: fixtureNumberId, ...opts });
  return prisma.customer.count({ where });
}

async function seed() {
  const number = await prisma.whatsAppNumber.upsert({
    where: { phoneNumberId: FIXTURE_PNID },
    update: {},
    create: {
      label: "Fixture", phoneNumberId: FIXTURE_PNID, wabaId: "waba_fixture",
      tokenEnvKey: "WHATSAPP_TOKEN_FIXTURE", isActive: true,
    },
  });
  fixtureNumberId = number.id;

  for (let i = 0; i < PEOPLE.length; i++) {
    const [name, gender, age, departments, tags, joinedDaysAgo, optedOut, lastInbound] = PEOPLE[i];
    const customer = await prisma.customer.create({
      data: {
        name,
        phone: `${TAG}${String(i).padStart(4, "0")}`,
        gender,
        // Mid-month so the age is unambiguous regardless of what day it is.
        dateOfBirth: iso(YEAR - age, BIRTH_MONTH(i), 15),
        joinDate: new Date(daysAgo(joinedDaysAgo).toISOString().slice(0, 10)),
        departments,
        tags,
        optedOut,
        nationality: i % 2 === 0 ? "Egyptian" : "Emirati",
      },
    });
    if (lastInbound !== null) {
      await prisma.conversation.create({
        data: {
          customerId: customer.id,
          whatsappNumberId: fixtureNumberId,
          lastCustomerMessageAt: daysAgo(lastInbound),
          lastMessageAt: daysAgo(lastInbound),
          lastSenderType: "CUSTOMER",
        },
      });
    }
  }
}

async function cleanup() {
  const rows = await prisma.customer.findMany({
    where: { phone: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversation: { customerId: { in: ids } } } }),
    prisma.customerOptOut.deleteMany({ where: { customerId: { in: ids } } }),
    prisma.conversation.deleteMany({ where: { customerId: { in: ids } } }),
    prisma.campaignRecipient.deleteMany({ where: { customerId: { in: ids } } }),
    prisma.customer.deleteMany({ where: { id: { in: ids } } }),
  ]);
  await prisma.whatsAppNumber.deleteMany({ where: { phoneNumberId: FIXTURE_PNID } });
  return ids.length;
}

(async () => {
  const existing = await prisma.customer.count();
  if (existing > 0) {
    console.log(`\n${Y}Refusing to run: the Customer table holds ${existing} rows.${RESET}`);
    console.log(`${D}This check seeds and deletes data, so it only runs against an empty table.${RESET}`);
    console.log(`${D}Use "npm run check:segments" for the read-only invariant checks instead.${RESET}\n`);
    await prisma.$disconnect();
    process.exit(0);
  }

  try {
    await seed();
    console.log(`\n${D}Seeded ${PEOPLE.length} contacts (6 female / 4 male, 2 opted out)${RESET}\n`);

    // ── demographics ───────────────────────────────────────────────────────
    await check("gender is FEMALE", 5, () => count([{ field: "gender", op: "eq", value: "FEMALE" }]));
    await check("gender is MALE", 5, () => count([{ field: "gender", op: "eq", value: "MALE" }]));

    // 28, 34, 41, 52, 67, 31, 45, 19, 58, 38
    await check("age at least 40", 5, () => count([{ field: "age", op: "gte", value: 40 }]));
    await check("age at most 30", 2, () => count([{ field: "age", op: "lte", value: 30 }]));
    await check("age between 30 and 45", 5, () => count([{ field: "age", op: "between", value: [30, 45] }]));

    await check("nationality is Egyptian", 5, () => count([{ field: "nationality", op: "in", value: ["Egyptian"] }]));
    await check("nationality matches case-insensitively", 5, () =>
      count([{ field: "nationality", op: "in", value: ["egyptian"] }]));
    await check("nationality is not Egyptian", 5, () => count([{ field: "nationality", op: "not_in", value: ["Egyptian"] }]));

    await check("birthday in January or February", 2, () =>
      count([{ field: "birthdayMonth", op: "in", value: [1, 2] }]));

    // ── departments & tags ─────────────────────────────────────────────────
    await check("department includes Dermatology", 5, () =>
      count([{ field: "department", op: "has_any", value: ["Dermatology"] }]));
    await check("department includes Dermatology AND Laser", 1, () =>
      count([{ field: "department", op: "has_all", value: ["Dermatology", "Laser"] }]));
    await check("department excludes Dermatology", 5, () =>
      count([{ field: "department", op: "has_none", value: ["Dermatology"] }]));
    await check("no department on file", 1, () =>
      count([{ field: "department", op: "is_empty", value: true }]));
    await check("tagged VIP", 3, () => count([{ field: "tag", op: "has_any", value: ["VIP"] }]));

    // ── dates ──────────────────────────────────────────────────────────────
    // joinDate is a `@db.Date` column, so Postgres compares by calendar day:
    // the contact who joined exactly 60 days ago IS inside "the last 60 days",
    // regardless of the time of day right now. Five joined inside the window
    // (5, 10, 20, 33, 45 days) plus Hani on the boundary at exactly 60.
    await check("joined in the last 60 days (boundary inclusive)", 6, () =>
      count([{ field: "joinDate", op: "in_last_days", value: 60 }]));
    await check("joined more than 365 days ago", 3, () =>
      count([{ field: "joinDate", op: "older_than_days", value: 365 }]));
    // in_last_days and older_than_days must partition the population exactly —
    // no contact counted twice, none lost between the two halves.
    await check("recent + lapsed joins cover everyone with a join date", 10, async () => {
      const recent = await count([{ field: "joinDate", op: "in_last_days", value: 60 }]);
      const old = await count([{ field: "joinDate", op: "older_than_days", value: 60 }]);
      return recent + old;
    });

    // ── engagement ─────────────────────────────────────────────────────────
    await check("has chatted before", 7, () =>
      count([{ field: "hasConversation", op: "eq", value: true }]));
    await check("never chatted", 3, () =>
      count([{ field: "hasConversation", op: "eq", value: false }]));
    // lapsed 60d+: the 3 with no conversation, plus 90d, 200d, 120d = 6
    await check("no inbound message in 60 days (includes never)", 6, () =>
      count([{ field: "lastInboundAt", op: "older_than_days", value: 60 }]));
    await check("inbound within 60 days", 4, () =>
      count([{ field: "lastInboundAt", op: "in_last_days", value: 60 }]));
    await check("never sent us a message", 3, () =>
      count([{ field: "lastInboundAt", op: "never", value: true }]));

    // ── ALL vs ANY ─────────────────────────────────────────────────────────
    const combo = [
      { field: "gender", op: "eq", value: "FEMALE" },
      { field: "department", op: "has_any", value: ["Dermatology"] },
    ];
    // Female AND dermatology: Amira, Layla, Huda
    await check("female AND dermatology (ALL)", 3, () => count(combo));
    // Female (5) OR dermatology (5), union = Amira, Layla, Noor, Sara, Huda, Karim, Hani
    await check("female OR dermatology (ANY)", 7, () => count(combo, {}, "ANY"));

    // ── consent, the non-negotiable ────────────────────────────────────────
    await check("everyone, consent ignored", 10, () => count([]));
    await check("everyone, consent enforced", 8, () => count([], { excludeOptedOut: true }));
    await check("opted-out only", 2, () => count([{ field: "optedOut", op: "eq", value: true }]));
    await check("opted-out contact is dropped from a matching audience", 0, async () => {
      // Sara is FEMALE + Nutrition + opted out. The rule matches her; consent must not.
      const ids = await resolveMemberIds(
        { match: "ALL", rules: [{ field: "department", op: "has_any", value: ["Nutrition"] }] },
        { excludeOptedOut: true },
      );
      return prisma.customer.count({ where: { id: { in: ids }, optedOut: true } });
    });

    // ── the guarantee the whole feature rests on ───────────────────────────
    await check("preview count equals the frozen recipient count", 0, async () => {
      const def = {
        match: "ALL",
        rules: [
          { field: "gender", op: "eq", value: "FEMALE" },
          { field: "lastInboundAt", op: "older_than_days", value: 60 },
        ],
      };
      const where = await buildCustomerWhere(def, { excludeOptedOut: true });
      const counted = await prisma.customer.count({ where });
      const frozen = await resolveMemberIds(def, { excludeOptedOut: true });
      return counted - frozen.length; // must be exactly 0
    });

    // ── search composes ────────────────────────────────────────────────────
    await check("search narrows inside an active rule", 1, () =>
      count([{ field: "gender", op: "eq", value: "FEMALE" }], { search: "Amira" }));

  } finally {
    const removed = await cleanup();
    console.log(`\n${D}Cleaned up ${removed} seeded contacts${RESET}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
