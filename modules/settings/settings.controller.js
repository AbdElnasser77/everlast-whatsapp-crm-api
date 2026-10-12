const axios = require("axios");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const numbers = require("../../utils/whatsappNumbers");
const { getApiVersion } = require("../../utils/whatsappClient");
const { getSetting, saveSetting, SETTING_KEYS } = require("../../utils/appSettings");
const { getQuietHoursConfig } = require("../../utils/quietHours");
const { emitGlobal } = require("../../utils/socket");
const logAudit = require("../../utils/audit");
const { checkNumberQuality } = require("../../jobs/numberQualityWatch");

// ─── GET /api/settings ──────────────────────────────────────────────────────
// What is in force right now. Quiet hours report where they come from: the
// Settings page once saved, the server config before that.
const getSettings = async (req, res, next) => {
  try {
    const qh = getQuietHoursConfig();
    res.status(200).json({
      success: true,
      data: {
        quietHours: { enabled: qh.enabled, start: qh.start, end: qh.end, timezone: qh.timezone, source: qh.source },
        campaignSafety: getSetting("campaignSafety"),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/settings/:key ─────────────────────────────────────────────────
const updateSetting = async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!SETTING_KEYS.includes(key)) return next(new AppError(`Unknown setting "${key}"`, 404));
    const before = key === "quietHours" ? getQuietHoursConfig() : getSetting(key);
    const saved = await saveSetting(key, req.body, req.user);
    logAudit({
      action: "SETTINGS_UPDATED",
      actor: req.user,
      targetType: "Setting",
      targetId: 0,
      details: { key, before, after: saved },
    });
    emitGlobal("settings.changed", { key });
    res.status(200).json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
};

// ── WhatsApp numbers ────────────────────────────────────────────────────────

// Token env var names that exist on this server — names only, never values.
// A number points at one of these; the token itself never leaves config.env.
const availableTokenKeys = () =>
  Object.keys(process.env)
    .filter((k) => numbers.TOKEN_ENV_KEY_RE.test(k) && process.env[k])
    .sort();

const numberView = (n) => ({
  id: n.id,
  label: n.label,
  phoneNumberId: n.phoneNumberId,
  wabaId: n.wabaId,
  displayPhoneNumber: n.displayPhoneNumber,
  tokenEnvKey: n.tokenEnvKey,
  hasToken: Boolean(process.env[n.tokenEnvKey]),
  isActive: n.isActive,
  isDefault: n.isDefault,
  sendConcurrency: n.sendConcurrency,
  qualityRating: n.qualityRating,
  metaStatus: n.metaStatus,
  qualityCheckedAt: n.qualityCheckedAt,
  createdAt: n.createdAt,
});

// ─── GET /api/settings/numbers ──────────────────────────────────────────────
const listNumbers = async (req, res, next) => {
  try {
    const rows = await prisma.whatsAppNumber.findMany({ orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
    const running = await prisma.campaign.groupBy({
      by: ["whatsappNumberId"],
      where: { status: { in: ["RUNNING", "SCHEDULED", "PAUSED"] } },
      _count: { _all: true },
    });
    const activeCampaigns = new Map(running.map((r) => [r.whatsappNumberId, r._count._all]));
    res.status(200).json({
      success: true,
      data: rows.map((n) => ({ ...numberView(n), activeCampaigns: activeCampaigns.get(n.id) || 0 })),
      tokenKeys: availableTokenKeys(),
    });
  } catch (err) {
    next(err);
  }
};

// Ask Meta about a number with a given token: proves the id and token match
// before the app starts sending from it.
async function lookUpAtMeta(phoneNumberId, tokenEnvKey) {
  const accessToken = process.env[tokenEnvKey];
  try {
    const { data } = await axios.get(`https://graph.facebook.com/${getApiVersion()}/${phoneNumberId}`, {
      params: { fields: "display_phone_number,verified_name,quality_rating,status" },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    return data;
  } catch (err) {
    const meta = err.response?.data?.error;
    throw new AppError(
      `Meta didn't accept this number with that token${meta ? `: ${meta.error_user_msg || meta.message}` : ""}. Check the phone number ID and that the token belongs to its business account.`,
      400,
      "NUMBER_LOOKUP_FAILED",
    );
  }
}

const validConcurrency = (v) => Number.isInteger(v) && v >= 1 && v <= 20;

// ─── POST /api/settings/numbers ─────────────────────────────────────────────
// Adds a number that is already registered and connected in WhatsApp Manager.
// (Registering a brand-new number — the verification code and PIN — is still
// done with `npm run wa:number`.)
const createNumber = async (req, res, next) => {
  try {
    const label = String(req.body.label || "").trim();
    const phoneNumberId = String(req.body.phoneNumberId || "").trim();
    const wabaId = String(req.body.wabaId || "").trim();
    const tokenEnvKey = String(req.body.tokenEnvKey || "").trim();
    const sendConcurrency = req.body.sendConcurrency === undefined ? 5 : Number(req.body.sendConcurrency);
    if (!label || !phoneNumberId || !wabaId || !tokenEnvKey) {
      return next(new AppError("Name, phone number ID, business account ID and token are all required", 400));
    }
    if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{5,30}$/.test(wabaId)) {
      return next(new AppError("The phone number ID and business account ID are the long numbers from WhatsApp Manager", 400));
    }
    if (!availableTokenKeys().includes(tokenEnvKey)) {
      return next(new AppError(`"${tokenEnvKey}" isn't set on the server. Add it to config.env first.`, 400));
    }
    if (!validConcurrency(sendConcurrency)) return next(new AppError("Send speed must be between 1 and 20", 400));
    if (await prisma.whatsAppNumber.findUnique({ where: { phoneNumberId } })) {
      return next(new AppError("This number is already added", 409));
    }

    const meta = await lookUpAtMeta(phoneNumberId, tokenEnvKey);
    const isFirst = (await prisma.whatsAppNumber.count()) === 0;
    const created = await prisma.whatsAppNumber.create({
      data: {
        label,
        phoneNumberId,
        wabaId,
        tokenEnvKey,
        sendConcurrency,
        displayPhoneNumber: meta.display_phone_number || null,
        qualityRating: meta.quality_rating || null,
        metaStatus: meta.status || null,
        qualityCheckedAt: new Date(),
        isDefault: isFirst,
      },
    });
    numbers.invalidate();
    logAudit({
      action: "NUMBER_CREATED",
      actor: req.user,
      targetType: "WhatsAppNumber",
      targetId: created.id,
      details: { label, phoneNumberId, wabaId, displayPhoneNumber: created.displayPhoneNumber },
    });
    emitGlobal("numbers.changed", { numberId: created.id });
    res.status(201).json({ success: true, data: numberView(created) });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/settings/numbers/:id ──────────────────────────────────────────
// Name, default line, on/off, send speed, token. The Meta ids can't change —
// a different id is a different number.
const updateNumber = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.whatsAppNumber.findUnique({ where: { id } });
    if (!existing) return next(new AppError("Number not found", 404));
    const data = {};
    const { label, isActive, isDefault, sendConcurrency, tokenEnvKey } = req.body;

    if (label !== undefined) {
      if (!String(label).trim()) return next(new AppError("The name can't be empty", 400));
      data.label = String(label).trim();
    }
    if (sendConcurrency !== undefined) {
      if (!validConcurrency(Number(sendConcurrency))) return next(new AppError("Send speed must be between 1 and 20", 400));
      data.sendConcurrency = Number(sendConcurrency);
    }
    if (tokenEnvKey !== undefined && tokenEnvKey !== existing.tokenEnvKey) {
      if (!availableTokenKeys().includes(tokenEnvKey)) {
        return next(new AppError(`"${tokenEnvKey}" isn't set on the server. Add it to config.env first.`, 400));
      }
      await lookUpAtMeta(existing.phoneNumberId, tokenEnvKey);
      data.tokenEnvKey = tokenEnvKey;
    }
    if (isActive === false && existing.isActive) {
      if (existing.isDefault) {
        return next(new AppError("This is the default number. Make another number the default before turning it off.", 400));
      }
      // Its running campaigns pause on their next heartbeat (NUMBER_INACTIVE);
      // the inbox stops offering it.
      data.isActive = false;
    }
    if (isActive === true) data.isActive = true;
    if (isDefault === true) {
      const willBeActive = data.isActive ?? existing.isActive;
      if (!willBeActive) return next(new AppError("Only an active number can be the default", 400));
      data.isDefault = true;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.whatsAppNumber.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
      return tx.whatsAppNumber.update({ where: { id }, data });
    });
    numbers.invalidate();
    logAudit({
      action: "NUMBER_UPDATED",
      actor: req.user,
      targetType: "WhatsAppNumber",
      targetId: id,
      details: { label: updated.label, changes: Object.keys(data), isActive: updated.isActive, isDefault: updated.isDefault },
    });
    emitGlobal("numbers.changed", { numberId: id });
    res.status(200).json({ success: true, data: numberView(updated) });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/settings/numbers/check-quality ───────────────────────────────
// "Check now" — the same check the 30-minute watch runs.
const checkQualityNow = async (req, res, next) => {
  try {
    const results = await checkNumberQuality();
    res.status(200).json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
};

module.exports = { getSettings, updateSetting, listNumbers, createNumber, updateNumber, checkQualityNow };
