// Single source of truth for template variable handling.
//
// The app authors templates with NAMED placeholders like {{customer_name}}.
// Meta's Cloud API only understands POSITIONAL placeholders ({{1}}, {{2}}) and
// the parameters sent at send-time must line up with those positions IN ORDER
// OF FIRST APPEARANCE in the body. Submit-time conversion and send-time
// parameter building must therefore use the exact same ordering — which is why
// both live here.

const RESOLVERS = {
  first_name: (customer) => (customer?.name ? customer.name.split(" ")[0] : "Customer"),
  customer_name: (customer) => customer?.name || "Customer",
  agent_name: (_customer, agent) => agent?.name || agent?.username || "Team",
};

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/gi;

// Unique, supported variable names in order of first appearance in the text.
const extractOrderedVars = (text) => {
  if (!text) return [];
  const seen = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (RESOLVERS[name] && !seen.includes(name)) seen.push(name);
  }
  return seen;
};

// Convert named placeholders to Meta positional ones ({{1}}, {{2}}, …) using
// order of first appearance. All occurrences of the same variable share an index.
const toMetaPositionalBody = (text) => {
  if (!text) return text;
  const order = extractOrderedVars(text);
  let out = text;
  order.forEach((name, i) => {
    const re = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "gi");
    out = out.replace(re, `{{${i + 1}}}`);
  });
  return out;
};

// Positional parameter VALUES for a Meta template send — same order as
// toMetaPositionalBody, so {{1}} always receives the right value.
const buildTemplateParams = (text, customer, agent) =>
  extractOrderedVars(text).map((name) => RESOLVERS[name](customer, agent));

// Replace named placeholders with resolved values (for the stored/preview copy
// and for GENERAL text/interactive sends that don't use Meta's template format).
const resolveNamedVars = (text, customer, agent) => {
  if (!text) return text;
  return text.replace(VAR_RE, (full, rawName) => {
    const name = rawName.toLowerCase();
    return RESOLVERS[name] ? RESOLVERS[name](customer, agent) : full;
  });
};

// Every {{...}} in the text, supported or not — for validation.
const ANY_PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const listPlaceholders = (text) => [...String(text || "").matchAll(ANY_PLACEHOLDER_RE)].map((m) => m[1]);
const SUPPORTED_VARS = Object.keys(RESOLVERS);

module.exports = {
  SUPPORTED_VARS,
  listPlaceholders,
  extractOrderedVars,
  toMetaPositionalBody,
  buildTemplateParams,
  resolveNamedVars,
};
