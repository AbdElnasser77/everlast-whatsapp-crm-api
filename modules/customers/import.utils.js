// Shared CSV-import helpers used by both the Contacts importer and the Lists
// importer, so the two stay in sync (phone/date/gender parsing, upload limits).
const { parse } = require("csv-parse/sync");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const AppError = require("../../utils/AppError");

// Validate & normalize a phone to WhatsApp-sendable international format (digits,
// no '+'). A number that carries its own country code is auto-detected (any
// country). A bare local number is interpreted using `country` (ISO-2, e.g.
// "AE"); with "auto" and no code the country is unknowable, so it's flagged.
// Returns { phone } on success or { error } otherwise.
function normalizeImportPhone(raw, country) {
  const s = (raw ?? "").toString().trim();
  if (!s) return { error: "Missing phone number" };
  const intl = s.replace(/^00/, "+"); // a leading 00 is the international prefix
  // A number carrying its own code auto-detects; code-less numbers fall back to
  // the chosen country, defaulting to UAE ("AE").
  const useCountry = country && country !== "auto" ? country : "AE";
  let pn;
  // Digits already in international form without the "+" (e.g. 201000682552,
  // which is what the contact form sends) must not be read as a UAE local
  // number. Try them as international first. 10+ digits and no leading 0 keeps
  // real local numbers (UAE mobile without the 0 is 9 digits) on the fallback.
  if (/^[1-9]\d{9,14}$/.test(intl.replace(/[\s\-().]/g, ""))) {
    try { pn = parsePhoneNumberFromString(`+${intl.replace(/\D/g, "")}`); } catch { pn = null; }
    if (!pn || !pn.isValid()) pn = null;
  }
  if (!pn) {
    try { pn = parsePhoneNumberFromString(intl, useCountry); } catch { pn = null; }
  }
  if (pn && pn.isValid()) {
    if (pn.getType() === "FIXED_LINE") return { error: "Landline — can't receive WhatsApp" };
    return { phone: pn.number.replace(/^\+/, "") };
  }
  return { error: "Invalid or unmessageable phone number" };
}

// ─── Field parsers ────────────────────────────────────────────────────────────

// Normalise gender input to the Prisma enum (MALE | FEMALE), or null.
function parseGender(value) {
  if (value == null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  if (["male", "m", "man", "men", "boy", "mr", "ذكر"].includes(v)) return "MALE";
  if (["female", "f", "woman", "women", "girl", "mrs", "ms", "miss", "أنثى", "انثى"].includes(v)) return "FEMALE";
  return undefined; // signal invalid
}

// Parse a date-only value (YYYY-MM-DD or any Date-parseable string) to a Date, or null.
function parseDate(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return undefined; // signal invalid
  return d;
}

// Flexible date parser for imports. format: "auto" | "dmy" | "mdy" | "ymd".
// Returns a Date, null (empty), or undefined (unparseable). Mirrors lib/customerImport.ts.
function buildDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return dt;
}

function parseFlexibleDate(value, format = "auto") {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/); // year-first
  if (m) return buildDate(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // day/month then year
  if (m) {
    const a = +m[1], b = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 50 ? 2000 : 1900;
    let day, month;
    if (format === "mdy") { month = a; day = b; }
    else if (format === "dmy") { day = a; month = b; }
    else if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { month = a; day = b; }
    else { day = a; month = b; } // prefer day-first
    return buildDate(y, month, day);
  }

  const parsed = new Date(s); // month-name formats
  if (!isNaN(parsed.getTime())) return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
  return undefined;
}

// Coerce departments/tags into a trimmed string array.
function toStringArray(value) {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return [];
}

// Split a semicolon/comma-delimited CSV cell into a trimmed string array.
function splitList(val) {
  if (!val) return [];
  const delimiter = val.includes(";") ? ";" : ",";
  return val.split(delimiter).map((t) => t.trim()).filter(Boolean);
}

// Parse a CSV upload into row objects (shared by validate + import endpoints).
function parseUpload(req) {
  if (!req.file) throw new AppError("CSV file is required", 400);
  let rows;
  try {
    rows = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch {
    throw new AppError("Invalid CSV format", 400);
  }
  if (rows.length === 0) throw new AppError("CSV file is empty", 400);
  if (rows.length > 20000) throw new AppError("CSV cannot exceed 20000 rows per import", 400);
  return rows;
}

module.exports = {
  normalizeImportPhone,
  parseGender,
  parseDate,
  parseFlexibleDate,
  toStringArray,
  splitList,
  parseUpload,
};
