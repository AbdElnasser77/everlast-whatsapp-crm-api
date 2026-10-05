const axios = require("axios");
const AppError = require("../../utils/AppError");
const numbers = require("../../utils/whatsappNumbers");
const { getApiVersion } = require("../../utils/whatsappClient");

// Fields documented on Meta's WhatsApp Business phone number object that
// carry reputation/health signal: `status` is the ban/flag/restriction state
// (CONNECTED / FLAGGED / RESTRICTED / BANNED), `quality_rating` is the
// GREEN/YELLOW/RED rating that drives it.
const CORE_FIELDS = [
  "verified_name",
  "display_phone_number",
  "quality_rating",
  "status",
  "name_status",
  "code_verification_status",
  "throughput",
].join(",");

const getPhoneNumberStatus = async (req, res, next) => {
  // Reports on the number currently SELECTED in the switcher, not on whatever the
  // environment happens to name — otherwise this page would contradict the
  // switcher the moment a second number existed.
  const { phoneNumberId, accessToken } = await numbers.getCredentials(req.numberId);


  const url = `https://graph.facebook.com/${getApiVersion()}/${phoneNumberId}`;
  const headers = { Authorization: `Bearer ${accessToken}` };

  try {
    const { data } = await axios.get(url, { params: { fields: CORE_FIELDS }, headers });

    // messaging_limit_tier is being phased out in favor of a Business
    // Portfolio-level field this account isn't configured for yet — fetched
    // best-effort in its own call so its removal can't break the rest of
    // the dashboard if Meta rejects the field for this app version.
    let messagingLimitTier = null;
    try {
      const tierRes = await axios.get(url, { params: { fields: "messaging_limit_tier" }, headers });
      messagingLimitTier = tierRes.data.messaging_limit_tier || null;
    } catch {
      messagingLimitTier = null;
    }

    res.status(200).json({
      success: true,
      data: {
        verifiedName: data.verified_name || null,
        displayPhoneNumber: data.display_phone_number || null,
        qualityRating: data.quality_rating || "UNKNOWN",
        status: data.status || "UNKNOWN",
        nameStatus: data.name_status || null,
        codeVerificationStatus: data.code_verification_status || null,
        throughputLevel: data.throughput?.level || null,
        messagingLimitTier,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    const metaError = err.response?.data?.error;
    if (metaError) {
      // Never relay Meta's own status code as-is — Meta returns 401 for an
      // expired/invalid WhatsApp access token, and the frontend treats ANY
      // 401 as "your CRM session expired," force-logging the user out. That
      // would turn a dead WhatsApp token into a false CRM logout. Always
      // surface this as a distinct upstream-failure status instead.
      return next(new AppError(`WhatsApp API error: ${metaError.message}`, 502));
    }
    next(err);
  }
};

// Lists every phone number Meta reports on the ACTIVE number's WABA — including
// ones this CRM has no row for yet. That difference is the point: it is how an
// operator spots a number that exists at Meta but has not been added here.
//
// For the switcher, use getConfiguredNumbers instead: this call goes out to
// Graph and can be slow or fail.
const getAllPhoneNumbers = async (req, res, next) => {
  const { wabaId, accessToken } = await numbers.getCredentials(req.numberId);



  try {
    const { data } = await axios.get(`https://graph.facebook.com/${getApiVersion()}/${wabaId}/phone_numbers`, {
      params: { fields: CORE_FIELDS },
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const numbers = (data.data || []).map((n) => ({
      id: n.id,
      verifiedName: n.verified_name || null,
      displayPhoneNumber: n.display_phone_number || null,
      qualityRating: n.quality_rating || "UNKNOWN",
      status: n.status || "UNKNOWN",
      nameStatus: n.name_status || null,
      codeVerificationStatus: n.code_verification_status || null,
      throughputLevel: n.throughput?.level || null,
      // isPrimary means "the number currently selected", not "the one the app is
      // hardwired to" — that concept no longer exists.
      isPrimary: n.id === req.number.phoneNumberId,
    }));

    res.status(200).json({ success: true, data: numbers, fetchedAt: new Date().toISOString() });
  } catch (err) {
    const metaError = err.response?.data?.error;
    if (metaError) {
      // Never relay Meta's own status code as-is — Meta returns 401 for an
      // expired/invalid WhatsApp access token, and the frontend treats ANY
      // 401 as "your CRM session expired," force-logging the user out. That
      // would turn a dead WhatsApp token into a false CRM logout. Always
      // surface this as a distinct upstream-failure status instead.
      return next(new AppError(`WhatsApp API error: ${metaError.message}`, 502));
    }
    next(err);
  }
};

// The switcher's data source. Deliberately NOT the live Meta call above: the
// switcher must render instantly and keep working when Graph is slow or down,
// and it needs the operator-chosen label, which Meta does not store.
//
// Never selects tokenEnvKey — an allow-list select rather than delete-after-fetch,
// so a token's env var name cannot leak into a response by accident.
const getConfiguredNumbers = async (req, res, next) => {
  try {
    // The default number — the business's main line — first, then the rest in
    // the order they were added. The switcher groups accounts in the order it
    // first meets them, so this also puts the main number's account on top.
    const rows = [...(await numbers.getAll())].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id,
    );

    // One lookup per distinct account, not per number — several numbers usually
    // share an account. Resolved in parallel and cached, so this is a no-op on
    // every request after the first hour's first one.
    const wabaIds = [...new Set(rows.map((n) => n.wabaId))];
    const names = Object.fromEntries(
      await Promise.all(wabaIds.map(async (w) => [w, await numbers.getAccountName(w)])),
    );

    res.status(200).json({
      success: true,
      data: rows.map((n) => ({
        // Null when Meta could not be reached; the client falls back to a label
        // built from the account id rather than showing nothing.
        accountName: names[n.wabaId] ?? null,
        id: n.id,
        label: n.label,
        phoneNumberId: n.phoneNumberId,
        wabaId: n.wabaId,
        displayPhoneNumber: n.displayPhoneNumber,
        isDefault: n.isDefault,
        isActive: n.isActive,
      })),
      activeNumberId: req.numberId,
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getConfiguredNumbers, getPhoneNumberStatus, getAllPhoneNumbers };
