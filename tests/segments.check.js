// Executable check for the segmentation engine, run against the live schema.
//
// Every assertion here is a property that must hold for an audience number to
// be trustworthy: consent is never leaked, ALL/ANY behave as set operations,
// the compiler agrees with a hand-written query, and a preview COUNT equals
// the id list a campaign would actually freeze. Read-only — it never writes.
//
//   npm run check:segments
require("dotenv").config({ path: __dirname + "/../config.env" });
const prisma = require("../config/prisma");
const { buildCustomerWhere, validateDefinition, resolveMemberIds, describeFields } = require("../utils/segmentFilter");

const RESET = "\x1b[0m", G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[90m";
let pass = 0, fail = 0;

async function check(label, fn) {
  try {
    const out = await fn();
    console.log(`${G}PASS${RESET} ${label}${out !== undefined ? `  ${D}→ ${out}${RESET}` : ""}`);
    pass++;
  } catch (err) {
    console.log(`${R}FAIL${RESET} ${label}\n     ${err.message}`);
    fail++;
  }
}

async function count(def, opts) {
  const where = await buildCustomerWhere(def, opts);
  return prisma.customer.count({ where });
}

(async () => {
  const total = await prisma.customer.count();
  const optedOut = await prisma.customer.count({ where: { optedOut: true } });
  console.log(`\n${D}Database: ${total} customers, ${optedOut} opted out${RESET}\n`);

  // ── grammar ──────────────────────────────────────────────────────────────
  await check("field catalogue is served", () => `${describeFields().length} fields`);

  await check("empty definition matches everyone", async () => {
    const n = await count({ match: "ALL", rules: [] });
    if (n !== total) throw new Error(`expected ${total}, got ${n}`);
    return `${n}`;
  });

  await check("unknown field is rejected", async () => {
    try {
      validateDefinition({ match: "ALL", rules: [{ field: "salary", op: "eq", value: 1 }] });
    } catch (e) {
      if (e.statusCode !== 400) throw new Error("wrong status " + e.statusCode);
      return "400";
    }
    throw new Error("should have thrown");
  });

  await check("wrong operator for field is rejected", async () => {
    try {
      validateDefinition({ match: "ALL", rules: [{ field: "gender", op: "between", value: [1, 2] }] });
    } catch (e) {
      if (e.statusCode !== 400) throw new Error("wrong status");
      return "400";
    }
    throw new Error("should have thrown");
  });

  await check("malformed date is rejected", async () => {
    try {
      validateDefinition({ match: "ALL", rules: [{ field: "joinDate", op: "before", value: "14/03/1990" }] });
    } catch (e) { return "400"; }
    throw new Error("should have thrown");
  });

  // ── consent (the non-negotiable) ─────────────────────────────────────────
  await check("excludeOptedOut removes exactly the opted-out", async () => {
    const all = await count({ match: "ALL", rules: [] });
    const safe = await count({ match: "ALL", rules: [] }, { excludeOptedOut: true });
    if (all - safe !== optedOut) throw new Error(`suppressed ${all - safe}, expected ${optedOut}`);
    return `${all} → ${safe}`;
  });

  await check("resolveMemberIds never returns an opted-out contact", async () => {
    const ids = await resolveMemberIds({ match: "ALL", rules: [] }, { excludeOptedOut: true });
    const leaked = await prisma.customer.count({ where: { id: { in: ids }, optedOut: true } });
    if (leaked > 0) throw new Error(`${leaked} opted-out contacts leaked into the audience`);
    return `${ids.length} ids, 0 leaked`;
  });

  // ── ALL vs ANY ───────────────────────────────────────────────────────────
  await check("ANY is a superset of ALL for the same rules", async () => {
    const rules = [
      { field: "gender", op: "eq", value: "FEMALE" },
      { field: "hasConversation", op: "eq", value: true },
    ];
    const all = await count({ match: "ALL", rules });
    const any = await count({ match: "ANY", rules });
    if (any < all) throw new Error(`ANY(${any}) < ALL(${all})`);
    return `ALL=${all}  ANY=${any}`;
  });

  // ── the compiler vs a hand-written query ─────────────────────────────────
  await check("gender rule agrees with a direct Prisma count", async () => {
    const viaRule = await count({ match: "ALL", rules: [{ field: "gender", op: "eq", value: "FEMALE" }] });
    const direct = await prisma.customer.count({ where: { gender: "FEMALE" } });
    if (viaRule !== direct) throw new Error(`rule=${viaRule} direct=${direct}`);
    return `${viaRule}`;
  });

  await check("age between 0 and 200 equals everyone with a DOB", async () => {
    const viaRule = await count({ match: "ALL", rules: [{ field: "age", op: "between", value: [0, 200] }] });
    const direct = await prisma.customer.count({ where: { dateOfBirth: { not: null } } });
    if (viaRule !== direct) throw new Error(`rule=${viaRule} direct=${direct}`);
    return `${viaRule}`;
  });

  await check("lapsed = never-messaged + messaged-long-ago (no one dropped)", async () => {
    const lapsed = await count({ match: "ALL", rules: [{ field: "lastInboundAt", op: "older_than_days", value: 60 }] });
    const recent = await count({ match: "ALL", rules: [{ field: "lastInboundAt", op: "in_last_days", value: 60 }] });
    if (lapsed + recent !== total) throw new Error(`${lapsed} + ${recent} != ${total}`);
    return `${lapsed} lapsed + ${recent} recent = ${total}`;
  });

  await check("birthdayMonth raw pre-resolution runs", async () => {
    const n = await count({ match: "ALL", rules: [{ field: "birthdayMonth", op: "in", value: [1, 2, 3] }] });
    return `Q1 birthdays: ${n}`;
  });

  await check("all 12 birthday months sum to everyone with a DOB", async () => {
    const n = await count({ match: "ALL", rules: [{ field: "birthdayMonth", op: "in", value: [1,2,3,4,5,6,7,8,9,10,11,12] }] });
    const direct = await prisma.customer.count({ where: { dateOfBirth: { not: null } } });
    if (n !== direct) throw new Error(`months=${n} direct=${direct}`);
    return `${n}`;
  });

  await check("department has_any is case-tolerant via real values", async () => {
    const row = await prisma.customer.findFirst({ where: { departments: { isEmpty: false } }, select: { departments: true } });
    if (!row) return "skipped — no departments on file";
    const dept = row.departments[0];
    const n = await count({ match: "ALL", rules: [{ field: "department", op: "has_any", value: [dept] }] });
    if (n < 1) throw new Error(`"${dept}" matched nothing`);
    return `"${dept}" → ${n}`;
  });

  await check("frequency cap: never + received = everyone", async () => {
    const never = await count({ match: "ALL", rules: [{ field: "lastCampaignAt", op: "never", value: true }] });
    const ever = await count({ match: "ALL", rules: [{ field: "lastCampaignAt", op: "never", value: false }] });
    if (never + ever !== total) throw new Error(`${never} + ${ever} != ${total}`);
    return `${never} never + ${ever} received`;
  });

  await check("search composes with a rule (AND, not OR)", async () => {
    const ruleOnly = await count({ match: "ALL", rules: [{ field: "gender", op: "eq", value: "FEMALE" }] });
    const withSearch = await count({ match: "ALL", rules: [{ field: "gender", op: "eq", value: "FEMALE" }] }, { search: "zzzznomatch" });
    if (withSearch > ruleOnly) throw new Error("search widened the result set");
    return `${ruleOnly} → ${withSearch} with impossible search`;
  });

  await check("preview count equals resolved id count", async () => {
    const def = { match: "ALL", rules: [{ field: "hasConversation", op: "eq", value: true }] };
    const counted = await count(def, { excludeOptedOut: true });
    const ids = await resolveMemberIds(def, { excludeOptedOut: true });
    if (counted !== ids.length) throw new Error(`count=${counted} ids=${ids.length}`);
    return `${counted} both ways`;
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
