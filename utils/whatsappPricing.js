const { parsePhoneNumberFromString } = require("libphonenumber-js");

// Meta per-message rates (USD), by the RECIPIENT's country and the message's
// pricing category. Meta charges on delivery, and only when the status
// webhook's pricing.billable is true — so these rates are only ever applied to
// messages Meta itself marked billable. Service messages are free today; the
// 0 is there so the table says so explicitly.
//
// Meta revises these: verify against WhatsApp Manager → Billing (or Meta's
// rate-card CSV) and update here. EG: effective Jan 1, 2026. AE: July 1, 2025
// (the same values as the campaign wizard's estimate).
const RATES_USD = {
  EG: { marketing: 0.0644, utility: 0.0036, authentication: 0.0036, service: 0 },
  AE: { marketing: 0.0384, utility: 0.0157, authentication: 0.0178, service: 0 },
};

const countryOf = (phone) => {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(String(phone).startsWith("+") ? phone : `+${phone}`);
  return parsed?.country || null;
};

// null when the country or category has no known rate — shown as "no rate",
// never silently counted as free.
const rateFor = (country, category) => {
  const rate = RATES_USD[country]?.[category];
  return rate === undefined ? null : rate;
};

module.exports = { RATES_USD, countryOf, rateFor };
