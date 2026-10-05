// Turn a Meta Graph API error into something a person can act on: Meta's own
// explanation (error_user_title / error_user_msg, which it writes for end
// users) plus which part of the template it is about, so the UI can point at
// that field instead of saying "Failed to submit".

const FIELD_HINTS = [
  ["header", /header/i],
  ["footer", /footer/i],
  ["buttons", /button/i],
  ["body", /\bbody\b|variable|parameter|placeholder/i],
  ["name", /\bname\b|already exists|language/i],
];

const describeMetaTemplateError = (data) => {
  const err = data?.error || {};
  const title = err.error_user_title || null;
  const detail = err.error_user_msg || err.message || null;
  const text = `${title || ""} ${detail || ""}`;
  const field = FIELD_HINTS.find(([, re]) => re.test(text))?.[0] || null;
  const message = title && detail ? `${title}: ${detail}` : detail || title || "Meta rejected the template";
  return { message, field, metaCode: err.code || null, metaSubcode: err.error_subcode || null };
};

module.exports = { describeMetaTemplateError };
