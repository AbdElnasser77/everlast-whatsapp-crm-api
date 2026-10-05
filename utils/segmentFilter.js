const prisma = require("../config/prisma");
const AppError = require("./AppError");

// ── The rule → Prisma `where` compiler ──────────────────────────────────────
//
// One source of truth for "who is in this audience". Everything that needs to
// answer that question — the customers list filter, the live preview count, a
// saved segment, and the campaign that freezes its recipients — compiles the
// same rule object through here. If they each built their own `where`, the
// count shown at approval could disagree with the rows actually sent to, which
// is exactly the failure a segmentation engine exists to prevent.
//
// Rule shape:
//   { match: "ALL" | "ANY", rules: [{ field, op, value }, ...] }

const MAX_RULES = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── value coercion ──────────────────────────────────────────────────────────

// joinDate and dateOfBirth are Prisma `@db.Date` columns, stored at UTC
// midnight. Building the comparison bound the same way keeps a "born
// 1990-03-14" row inside a range whose edge is that same day — local-midnight
// parsing would shift it by the server's offset and silently drop it.
function parseDay(value, field, op) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new AppError(`${field} ${op} expects a date as YYYY-MM-DD`, 400);
  }
  const d = new Date(`${value.trim()}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new AppError(`${field} ${op} has an invalid date`, 400);
  return d;
}

// End of the given day, so `between` is inclusive of its upper bound.
function endOfDay(value, field, op) {
  return new Date(parseDay(value, field, op).getTime() + DAY_MS - 1);
}

function parseCount(value, field, op) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new AppError(`${field} ${op} expects a positive number`, 400);
  return n;
}

function daysAgo(n) {
  return new Date(Date.now() - n * DAY_MS);
}

// Conversation rules are evaluated against the ACTIVE number by default. A
// campaign sends from exactly one line, so "hasn't written in 60 days" is a
// statement about the relationship on THAT line. Defaulting to "any number"
// would silently gut re-engagement on a newly added number: everybody would
// look recently engaged because of the old one.
//
// A rule may opt out with scope: "ANY" — stored inside the segment definition,
// so an existing saved segment keeps meaning exactly what it meant.
function convScope(ctx) {
  if (!ctx || !ctx.whatsappNumberId || ctx.scope === "ANY") return {};
  return { whatsappNumberId: ctx.whatsappNumberId };
}

// CampaignRecipient carries no number of its own, so it is scoped through the
// campaign that produced it.
function campaignScope(ctx) {
  if (!ctx || !ctx.whatsappNumberId || ctx.scope !== "NUMBER") return {};
  return { campaign: { whatsappNumberId: ctx.whatsappNumberId } };
}

function parsePair(value, field, op) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new AppError(`${field} ${op} expects a two-item [from, to] array`, 400);
  }
  return value;
}

function parseList(value, field, op) {
  const arr = Array.isArray(value) ? value : [value];
  const cleaned = arr
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter((v) => v !== "" && v !== null && v !== undefined);
  if (cleaned.length === 0) throw new AppError(`${field} ${op} expects at least one value`, 400);
  return cleaned;
}

function parseText(value, field, op) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(`${field} ${op} expects a non-empty text value`, 400);
  }
  return value.trim();
}

function parseBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function parseIntList(value, field, op) {
  const ids = parseList(value, field, op)
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isInteger(n));
  if (ids.length === 0) throw new AppError(`${field} ${op} expects at least one numeric id`, 400);
  return ids;
}

// Age → date-of-birth bounds. Someone is "30 or older" if born on or before
// today-30y; "45 or younger" if born after today-46y, since the day they turn
// 46 they leave the bucket.
function dobUpperBoundForMinAge(minAge) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - minAge, now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
}
function dobLowerBoundForMaxAge(maxAge) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - maxAge - 1, now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}

// Shared date-field builder: joinDate and createdAt take the same operators.
//
// One difference worth knowing, because it is invisible in the rule itself:
// joinDate and dateOfBirth are `@db.Date` columns, so Postgres compares them by
// CALENDAR DAY — "joined in the last 60 days" includes everyone dated 60 days
// ago, whatever the time of day now. createdAt is a full timestamp, so the same
// operator there cuts at the exact hour, 60*24h back. Both are the natural
// reading of their own column; the behaviour is pinned by
// tests/segments.fixture.check.js so it can't drift silently.
function dateOps(column) {
  return {
    before: (v, f, o) => ({ [column]: { lt: parseDay(v, f, o) } }),
    after: (v, f, o) => ({ [column]: { gt: endOfDay(v, f, o) } }),
    between: (v, f, o) => {
      const [from, to] = parsePair(v, f, o);
      return { [column]: { gte: parseDay(from, f, o), lte: endOfDay(to, f, o) } };
    },
    in_last_days: (v, f, o) => ({ [column]: { gte: daysAgo(parseCount(v, f, o)) } }),
    older_than_days: (v, f, o) => ({ [column]: { lt: daysAgo(parseCount(v, f, o)) } }),
    exists: (v) => (parseBool(v) ? { [column]: { not: null } } : { [column]: null }),
  };
}

// Case-insensitive membership for free-text columns. Prisma's `in` is exact, so
// a segment on "Dermatology" would silently miss a row imported as
// "dermatology" — an OR of insensitive equals is what makes the count
// trustworthy against real imported data.
function insensitiveIn(column, values) {
  return { OR: values.map((v) => ({ [column]: { equals: String(v), mode: "insensitive" } })) };
}

// ── field registry ──────────────────────────────────────────────────────────

const FIELDS = {
  name: {
    label: "Name",
    ops: {
      contains: (v, f, o) => ({ name: { contains: parseText(v, f, o), mode: "insensitive" } }),
      exists: (v) => (parseBool(v) ? { NOT: { name: null } } : { name: null }),
    },
  },

  phone: {
    label: "Mobile",
    ops: {
      contains: (v, f, o) => ({ phone: { contains: parseText(v, f, o) } }),
      // Country targeting: "+971" reaches every UAE number on file.
      starts_with: (v, f, o) => ({ phone: { startsWith: parseText(v, f, o).replace(/^\+/, "") } }),
    },
  },

  email: {
    label: "Email",
    ops: {
      contains: (v, f, o) => ({ email: { contains: parseText(v, f, o), mode: "insensitive" } }),
      exists: (v) => (parseBool(v) ? { NOT: { email: null } } : { email: null }),
    },
  },

  chartNumber: {
    label: "Chart number",
    ops: {
      exists: (v) => (parseBool(v) ? { NOT: { chartNumber: null } } : { chartNumber: null }),
    },
  },

  nationality: {
    label: "Nationality",
    ops: {
      in: (v, f, o) => insensitiveIn("nationality", parseList(v, f, o)),
      not_in: (v, f, o) => ({ NOT: insensitiveIn("nationality", parseList(v, f, o)) }),
      exists: (v) => (parseBool(v) ? { NOT: { nationality: null } } : { nationality: null }),
    },
  },

  gender: {
    label: "Gender",
    ops: {
      eq: (v, f, o) => {
        const g = parseText(v, f, o).toUpperCase();
        if (g !== "MALE" && g !== "FEMALE") throw new AppError("gender must be MALE or FEMALE", 400);
        return { gender: g };
      },
      exists: (v) => (parseBool(v) ? { NOT: { gender: null } } : { gender: null }),
    },
  },

  // departments and tags are String[] columns, so Prisma's array operators
  // apply. hasSome is case-sensitive against stored values — the /options
  // endpoint feeds the UI the real distinct values so the user picks rather
  // than types, which is what keeps these honest.
  department: {
    label: "Department",
    ops: {
      has_any: (v, f, o) => ({ departments: { hasSome: parseList(v, f, o) } }),
      has_all: (v, f, o) => ({ departments: { hasEvery: parseList(v, f, o) } }),
      has_none: (v, f, o) => ({ NOT: { departments: { hasSome: parseList(v, f, o) } } }),
      is_empty: (v) => (parseBool(v) ? { departments: { isEmpty: true } } : { departments: { isEmpty: false } }),
    },
  },

  tag: {
    label: "Tag",
    ops: {
      has_any: (v, f, o) => ({ tags: { hasSome: parseList(v, f, o) } }),
      has_all: (v, f, o) => ({ tags: { hasEvery: parseList(v, f, o) } }),
      has_none: (v, f, o) => ({ NOT: { tags: { hasSome: parseList(v, f, o) } } }),
      is_empty: (v) => (parseBool(v) ? { tags: { isEmpty: true } } : { tags: { isEmpty: false } }),
    },
  },

  joinDate: { label: "Join date", ops: dateOps("joinDate") },
  createdAt: { label: "Added to CRM", ops: dateOps("createdAt") },

  age: {
    label: "Age",
    ops: {
      gte: (v, f, o) => ({ dateOfBirth: { lte: dobUpperBoundForMinAge(parseCount(v, f, o)) } }),
      lte: (v, f, o) => ({ dateOfBirth: { gte: dobLowerBoundForMaxAge(parseCount(v, f, o)) } }),
      between: (v, f, o) => {
        const [min, max] = parsePair(v, f, o);
        return {
          dateOfBirth: {
            gte: dobLowerBoundForMaxAge(parseCount(max, f, o)),
            lte: dobUpperBoundForMinAge(parseCount(min, f, o)),
          },
        };
      },
    },
  },

  // Birthday campaigns. Postgres answers this with EXTRACT, but Prisma has no
  // expression filter for it, so this one rule is pre-resolved to ids by a raw
  // query (see resolveRawFields). Only runs when the rule is actually present.
  birthdayMonth: {
    label: "Birthday month",
    raw: true,
    ops: {
      in: (v, f, o) => {
        const months = parseIntList(v, f, o).filter((m) => m >= 1 && m <= 12);
        if (!months.length) throw new AppError("birthdayMonth expects months 1-12", 400);
        return months;
      },
    },
  },

  optedOut: {
    label: "Opted out",
    ops: { eq: (v) => ({ optedOut: parseBool(v) }) },
  },

  hasConversation: {
    label: "Has chatted before",
    ops: {
      eq: (v, f, o, ctx) =>
        parseBool(v)
          ? { conversations: { some: convScope(ctx) } }
          : { conversations: { none: convScope(ctx) } },
    },
  },

  // Engagement recency. "No inbound in 60 days" has to include people who have
  // never written at all — they are the most lapsed of the lot, and excluding
  // them is the bug that makes a re-engagement campaign miss its whole point.
  lastInboundAt: {
    label: "Last message from patient",
    ops: {
      in_last_days: (v, f, o, ctx) => ({
        conversations: {
          some: { ...convScope(ctx), lastCustomerMessageAt: { gte: daysAgo(parseCount(v, f, o)) } },
        },
      }),
      // "No conversation on this line has a recent inbound" collapses the old
      // three-branch OR into one clause and naturally covers both "never talked
      // to us at all" and "talked but lastCustomerMessageAt is null". It is also
      // strictly more correct now that a customer can hold several threads: the
      // OR form would have matched someone with a stale thread even when another
      // thread was active.
      older_than_days: (v, f, o, ctx) => ({
        conversations: {
          none: { ...convScope(ctx), lastCustomerMessageAt: { gte: daysAgo(parseCount(v, f, o)) } },
        },
      }),
      never: (v, f, o, ctx) =>
        parseBool(v)
          ? { conversations: { none: { ...convScope(ctx), lastCustomerMessageAt: { not: null } } } }
          : { conversations: { some: { ...convScope(ctx), lastCustomerMessageAt: { not: null } } } },
    },
  },

  // Frequency capping — the rule that protects the number as much as the
  // patient. "Hasn't had a campaign in 14 days" is older_than_days: 14.
  //
  // Unlike every other conversation rule this defaults to ACROSS ALL NUMBERS.
  // Frequency capping exists to protect the patient, and a patient does not care
  // which of our lines messaged them twice this week. Opt into per-number
  // counting with scope: "NUMBER" on the rule.
  lastCampaignAt: {
    label: "Last campaign received (any number)",
    defaultScope: "ANY",
    ops: {
      in_last_days: (v, f, o, ctx) => ({
        campaignRecipients: {
          some: { status: "SENT", sentAt: { gte: daysAgo(parseCount(v, f, o)) }, ...campaignScope(ctx) },
        },
      }),
      older_than_days: (v, f, o, ctx) => ({
        campaignRecipients: {
          none: { status: "SENT", sentAt: { gte: daysAgo(parseCount(v, f, o)) }, ...campaignScope(ctx) },
        },
      }),
      never: (v, f, o, ctx) =>
        parseBool(v)
          ? { campaignRecipients: { none: { status: "SENT", ...campaignScope(ctx) } } }
          : { campaignRecipients: { some: { status: "SENT", ...campaignScope(ctx) } } },
    },
  },

  // Lists compose with rules instead of competing with them: "everyone on the
  // VIP list who hasn't heard from us in 30 days" becomes one segment, not a
  // manual cross-reference of two screens.
  list: {
    label: "Contact list",
    ops: {
      in: (v, f, o) => ({ listMemberships: { some: { listId: { in: parseIntList(v, f, o) } } } }),
      not_in: (v, f, o) => ({ listMemberships: { none: { listId: { in: parseIntList(v, f, o) } } } }),
    },
  },
};

// ── compilation ─────────────────────────────────────────────────────────────

function normalizeDefinition(definition) {
  const def = definition && typeof definition === "object" ? definition : {};
  const match = String(def.match || "ALL").toUpperCase();
  if (match !== "ALL" && match !== "ANY") {
    throw new AppError("match must be ALL or ANY", 400);
  }
  const rules = Array.isArray(def.rules) ? def.rules : [];
  if (rules.length > MAX_RULES) {
    throw new AppError(`A segment can hold at most ${MAX_RULES} rules`, 400);
  }
  return { match, rules };
}

function compileRule(rule, ctx = {}) {
  if (!rule || typeof rule !== "object") throw new AppError("Each rule must be an object", 400);
  const { field, op } = rule;

  const spec = FIELDS[field];
  if (!spec) throw new AppError(`Unknown filter field "${field}"`, 400);

  const builder = spec.ops[op];
  if (!builder) {
    throw new AppError(
      `Operator "${op}" is not valid for ${field}. Valid: ${Object.keys(spec.ops).join(", ")}`,
      400,
    );
  }
  if (rule.scope !== undefined && rule.scope !== "NUMBER" && rule.scope !== "ANY") {
    throw new AppError(`Rule scope must be "NUMBER" or "ANY", got "${rule.scope}"`, 400);
  }

  return builder(rule.value, field, op, {
    ...ctx,
    scope: rule.scope || spec.defaultScope || "NUMBER",
  });
}

// Rules that can't be expressed as a Prisma filter get resolved to a concrete
// id set first, then folded back in as `id: { in: [...] }`. Kept deliberately
// narrow — one round trip, and only when such a rule is actually used.
async function resolveRawFields(rules) {
  const clauses = [];
  for (const rule of rules) {
    if (FIELDS[rule?.field]?.raw !== true) continue;
    if (rule.field === "birthdayMonth") {
      const months = compileRule(rule);
      const rows = await prisma.$queryRaw`
        SELECT id FROM "Customer"
        WHERE "dateOfBirth" IS NOT NULL
          AND EXTRACT(MONTH FROM "dateOfBirth") = ANY(${months}::int[])
      `;
      clauses.push({ id: { in: rows.map((r) => r.id) } });
    }
  }
  return clauses;
}

/**
 * Compile a segment definition into a Prisma `where` for Customer.
 *
 * @param {object} definition              { match, rules }
 * @param {object} [opts]
 * @param {boolean} [opts.excludeOptedOut] Force out anyone who opted out,
 *        whatever the rules say. Always true on a campaign send path — consent
 *        is not something a saved rule gets to override.
 * @param {string} [opts.search]           Free-text term ANDed on top, so the
 *        customers screen can search inside an active filter.
 */
async function buildCustomerWhere(definition, opts = {}) {
  const { match, rules } = normalizeDefinition(definition);

  const ctx = { whatsappNumberId: opts.whatsappNumberId || null };
  const compiled = rules
    .filter((r) => FIELDS[r?.field]?.raw !== true)
    .map((r) => compileRule(r, ctx));
  const rawClauses = await resolveRawFields(rules);
  const ruleClauses = [...compiled, ...rawClauses];

  // ANY is an OR across the rules; a raw-resolved clause is still just a
  // clause, so both modes treat them identically.
  let where = {};
  if (ruleClauses.length === 1 && match === "ALL") {
    where = ruleClauses[0];
  } else if (ruleClauses.length > 0) {
    where = match === "ANY" ? { OR: ruleClauses } : { AND: ruleClauses };
  }

  const outer = [];
  if (ruleClauses.length > 0) outer.push(where);
  if (opts.excludeOptedOut) {
    // Two independent consent gates: the global do-not-contact flag, and a STOP
    // sent to the specific line this audience is being built for.
    outer.push({ optedOut: false });
    if (opts.whatsappNumberId) {
      outer.push({ optOuts: { none: { whatsappNumberId: opts.whatsappNumberId } } });
    }
  }

  if (opts.search) {
    const q = String(opts.search).trim();
    if (q) {
      outer.push({
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { chartNumber: { contains: q, mode: "insensitive" } },
        ],
      });
    }
  }

  if (outer.length === 0) return {};
  if (outer.length === 1) return outer[0];
  return { AND: outer };
}

/**
 * Validate a definition without running it. Throws AppError on the first
 * problem so a bad segment is rejected at save time, not at send time.
 */
function validateDefinition(definition) {
  const { rules } = normalizeDefinition(definition);
  rules.forEach(compileRule);
  return true;
}

/** Every customer id matching a definition. Used to freeze a campaign audience. */
async function resolveMemberIds(definition, opts = {}) {
  const where = await buildCustomerWhere(definition, opts);
  const rows = await prisma.customer.findMany({ where, select: { id: true }, orderBy: { id: "asc" } });
  return rows.map((r) => r.id);
}

/** Machine-readable field catalogue, so the UI never hardcodes the rule grammar. */
function describeFields() {
  return Object.entries(FIELDS).map(([key, spec]) => ({
    field: key,
    label: spec.label,
    ops: Object.keys(spec.ops),
  }));
}

module.exports = {
  buildCustomerWhere,
  validateDefinition,
  resolveMemberIds,
  describeFields,
  normalizeDefinition,
  MAX_RULES,
};
