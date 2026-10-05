// Single source of truth for "which WhatsApp line are we acting as, and what
// credentials reach it". Nothing outside this module may read a WhatsApp phone
// number id, WABA id or access token from the environment.
//
// Numbers live in the DB; their TOKENS live in the environment, named by the
// row's `tokenEnvKey`. That split keeps long-lived Meta tokens out of Postgres
// and out of every database backup, at the cost of a deploy to add a number.

const axios = require("axios");
const prisma = require("../config/prisma");
const AppError = require("./AppError");
const { getApiVersion } = require("./whatsappClient");

// A DB-controlled string is about to index process.env, so it is constrained to
// a namespace that cannot name anything else. Without this, a row (or anything
// able to write one) could point tokenEnvKey at JWT_SECRET or DATABASE_URL and
// have it loaded as a bearer token — turning any error path that echoes a
// credential into an exfiltration channel.
//
// Enforced on READ, not only on write: write-side validation alone does nothing
// about a row inserted out of band, by a migration, or by a future admin tool.
//
// WHATSAPP_ACCESS_TOKEN is permitted so the pre-existing single-number setup
// keeps working without renaming anything. The security property is the
// namespace confinement, not the exact spelling — nothing matching this can
// name JWT_SECRET, DATABASE_URL or any other unrelated secret.
const TOKEN_ENV_KEY_RE = /^WHATSAPP_(ACCESS_TOKEN|TOKEN_[A-Z0-9_]{1,40})$/;

const CACHE_TTL_MS = 60_000;

let byId = new Map();
let byPhoneNumberId = new Map();
let defaultId = null;
let loadedAt = 0;
// Concurrent misses share one query. middleware/auth.js already does a DB read
// per request; a cold cache under a burst (a Neon cold start, say) must not turn
// into N identical findMany calls against the same pool.
let inFlight = null;

const isFresh = () => loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS;

async function load() {
  const rows = await prisma.whatsAppNumber.findMany({ orderBy: { id: "asc" } });

  const nextById = new Map();
  const nextByPnid = new Map();
  let nextDefault = null;

  for (const row of rows) {
    nextById.set(row.id, row);
    nextByPnid.set(row.phoneNumberId, row);
    if (row.isDefault && row.isActive) nextDefault = row.id;
  }

  // No explicit default (or it was deactivated): fall back to the first active
  // number so the app still has somewhere to send from rather than 500ing.
  if (nextDefault === null) {
    const firstActive = rows.find((r) => r.isActive);
    nextDefault = firstActive ? firstActive.id : null;
  }

  byId = nextById;
  byPhoneNumberId = nextByPnid;
  defaultId = nextDefault;
  loadedAt = Date.now();
  return rows;
}

async function ensureLoaded() {
  if (isFresh()) return;
  if (!inFlight) {
    inFlight = load().finally(() => {
      inFlight = null;
    });
  }
  await inFlight;
}

// Call after any write to WhatsAppNumber. Exact within this process; the TTL is
// what bounds staleness for any other process. (A second instance would also
// break campaign pause — see campaign.controller.js — so single-instance is
// already assumed. LISTEN/NOTIFY is the real multi-instance answer.)
function invalidate() {
  loadedAt = 0;
}

async function getAll({ includeInactive = false } = {}) {
  await ensureLoaded();
  const rows = [...byId.values()];
  return includeInactive ? rows : rows.filter((r) => r.isActive);
}

async function getById(id) {
  await ensureLoaded();
  return byId.get(Number(id)) || null;
}

async function getByPhoneNumberId(phoneNumberId) {
  await ensureLoaded();
  return byPhoneNumberId.get(String(phoneNumberId)) || null;
}

async function getDefault() {
  await ensureLoaded();
  return defaultId === null ? null : byId.get(defaultId) || null;
}

// Resolves the row plus its secret. This is the ONLY place a token is read.
// Returns a fresh object each call and is never attached to `req`, so a token
// cannot reach an error serializer or a request log.
async function getCredentials(idOrRow) {
  const number =
    idOrRow && typeof idOrRow === "object" ? idOrRow : await getById(idOrRow);

  if (!number) {
    throw new AppError("WhatsApp number not found", 400, "NUMBER_NOT_FOUND");
  }

  if (!TOKEN_ENV_KEY_RE.test(number.tokenEnvKey || "")) {
    // Deliberately does not echo the offending value.
    throw new AppError(
      `WhatsApp number "${number.label}" has an invalid tokenEnvKey — it must match WHATSAPP_TOKEN_*`,
      500,
      "NUMBER_TOKEN_MISSING",
    );
  }

  const accessToken = process.env[number.tokenEnvKey];
  if (!accessToken) {
    throw new AppError(
      `WhatsApp number "${number.label}" has no token — set ${number.tokenEnvKey} in config.env`,
      500,
      "NUMBER_TOKEN_MISSING",
    );
  }

  return {
    id: number.id,
    label: number.label,
    phoneNumberId: number.phoneNumberId,
    wabaId: number.wabaId,
    appId: number.appId || process.env.WHATSAPP_APP_ID || null,
    accessToken,
  };
}

// Template approval is per-WABA, so syncing approval status needs one token per
// WABA rather than one token overall.
async function getTokenForWaba(wabaId) {
  const numbers = await getAll();
  const match = numbers.find((n) => n.wabaId === wabaId);
  if (!match) {
    throw new AppError(
      `No active WhatsApp number is configured for WABA ${wabaId}`,
      500,
      "NUMBER_NOT_FOUND",
    );
  }
  return (await getCredentials(match)).accessToken;
}

// A template approved on one WABA cannot be sent from a number on another —
// Meta rejects the template name as unknown. Catching it here turns a confusing
// upstream 400 into a clear, actionable error before anything is sent.
function assertTemplateUsable(template, number) {
  if (!template) {
    throw new AppError("Template not found", 404, "TEMPLATE_NOT_FOUND");
  }
  if (template.wabaId !== number.wabaId) {
    throw new AppError(
      `Template "${template.name}" belongs to a different WhatsApp Business Account than "${number.label}" sends from. Recreate it while "${number.label}" is selected.`,
      400,
      "TEMPLATE_WABA_MISMATCH",
    );
  }
}

// Called once at boot. A number whose token is missing must be loud at startup,
// not discovered when a campaign fails at 2am — but it must not stop the server,
// or one dead token takes down every other number too.
async function warmup() {
  const rows = await load();

  if (rows.length === 0) {
    console.warn(
      "[WhatsApp] No numbers configured — run `npm run seed:numbers` before sending or receiving",
    );
    return;
  }

  const problems = [];
  for (const row of rows) {
    if (!row.isActive) continue;
    try {
      await getCredentials(row);
    } catch (err) {
      problems.push(`  ✗ ${row.label} (${row.displayPhoneNumber || row.phoneNumberId}): ${err.message}`);
    }
  }

  const active = rows.filter((r) => r.isActive).length;
  const def = defaultId === null ? "none" : byId.get(defaultId)?.label;
  console.log(`[WhatsApp] ${active} active number(s) loaded · default: ${def}`);
  if (problems.length) {
    console.warn(`[WhatsApp] ${problems.length} number(s) cannot send:\n${problems.join("\n")}`);
  }
}

// ── WhatsApp account (WABA) display names ──────────────────────────────────
//
// The switcher groups numbers under the WhatsApp account they belong to, labelled
// with the name the business already knows it by in WhatsApp Manager. That name
// lives at Meta, so it is fetched rather than duplicated into config where it
// would drift the first time someone renamed the account.
//
// Cached for an hour: account names change roughly never, and the switcher's
// list is requested on every page load. A failed lookup is retried after a few
// minutes rather than on every request, and keeps any name it already had — a
// Graph outage must never blank the switcher or slow it down.
const ACCOUNT_NAME_TTL_MS = 60 * 60 * 1000;
const ACCOUNT_NAME_RETRY_MS = 5 * 60 * 1000;
const ACCOUNT_NAME_TIMEOUT_MS = 4000;
const accountNames = new Map(); // wabaId -> { name, expiresAt }

async function getAccountName(wabaId) {
  const cached = accountNames.get(wabaId);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  try {
    const token = await getTokenForWaba(wabaId);
    const res = await axios.get(`https://graph.facebook.com/${getApiVersion()}/${wabaId}`, {
      params: { fields: "name" },
      headers: { Authorization: `Bearer ${token}` },
      timeout: ACCOUNT_NAME_TIMEOUT_MS,
    });
    const name = res.data?.name || null;
    accountNames.set(wabaId, { name, expiresAt: Date.now() + ACCOUNT_NAME_TTL_MS });
    return name;
  } catch (err) {
    console.warn(`[WhatsApp] could not fetch name for account ${wabaId}: ${err.response?.data?.error?.message || err.message}`);
    const name = cached?.name ?? null;
    accountNames.set(wabaId, { name, expiresAt: Date.now() + ACCOUNT_NAME_RETRY_MS });
    return name;
  }
}

module.exports = {
  getAccountName,
  getAll,
  getById,
  getByPhoneNumberId,
  getDefault,
  getCredentials,
  getTokenForWaba,
  assertTemplateUsable,
  invalidate,
  warmup,
  TOKEN_ENV_KEY_RE,
};
