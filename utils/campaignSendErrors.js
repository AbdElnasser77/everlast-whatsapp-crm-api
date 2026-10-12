// What a failed campaign send means, and what the send loop should do about it.
//
// The question that matters for every error is "could Meta have delivered
// it?". Only when the answer is a definite no may the recipient be retried —
// otherwise a retry can deliver the campaign twice. Each kind:
//
//   RETRY       Meta refused with a temporary error, or the request never left
//               this machine. Not delivered; retried with backoff.
//   RATE_LIMIT  Meta's throughput limit. Not delivered; retried with backoff,
//               then the campaign pauses and resumes itself later.
//   REQUEUE     Too many messages to this one person recently (pair limit).
//               Not delivered; tried again later in the run.
//   AMBIGUOUS   The request may have reached Meta (timeout, connection cut,
//               a non-Meta 5xx). Never retried: FAILED "Not confirmed".
//   RECIPIENT   About this person only (not on WhatsApp, blocked marketing…).
//               FAILED with Meta's reason; the campaign carries on.
//   PROBE       Looks account-wide but is often one person's data (a bad
//               parameter). The loop checks with the next recipients before
//               deciding — see runCampaign.
//   SYSTEMIC    About the account, token or template. Every send would fail
//               the same way: the campaign pauses and nobody is burned.
//
// Codes from Meta's Cloud API error reference.

const RETRY_CODES = new Set([
  1, // API unknown — temporary
  2, // API service — temporary downtime
  131000, // something went wrong — Meta asks to retry
  131016, // service unavailable
  133004, // server temporarily unavailable
]);
const RATE_LIMIT_CODES = new Set([
  4, // app-level call limit
  80007, // WABA rate limit
  130429, // Cloud API throughput limit
]);
const REQUEUE_CODES = new Set([
  131056, // pair rate limit: too many messages to this one number
]);
const RECIPIENT_CODES = new Set([
  131021, // recipient is the sender
  131026, // undeliverable: not on WhatsApp, old app, didn't accept terms
  131047, // re-engagement: 24h window closed (non-template)
  131049, // Meta's per-user marketing limit ("healthy ecosystem")
  131050, // user stopped marketing messages
  131051, // unsupported message type for this user
  131052, 131053, // media download / upload for this message
  130472, // user is part of a Meta experiment
]);
const PROBE_CODES = new Set([
  100, // invalid parameter — often one person's value
  131008, // required parameter missing
  131009, // parameter value invalid
  132000, // parameter count mismatch
  132005, // translated text too long (a long name)
  132012, // parameter format mismatch
  132018, // parameter contains newline / tab / too many spaces
]);
const SYSTEMIC_CODES = new Set([
  0, 3, 10, 190, 200, // auth / permission / token
  368, 131031, // account temporarily blocked / locked
  131042, // payment problem
  131048, // spam rate limit — the number's quality, needs a person
  132001, // template doesn't exist (in this language)
  132007, // template content policy
  132015, // template paused
  132016, // template disabled
  133010, // phone number not registered
]);

// Network errors where the request provably never reached Meta.
const NEVER_SENT_NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL", "CERT_HAS_EXPIRED"]);

function classifySendError(err) {
  const metaErr = err?.response?.data?.error || null;
  if (metaErr && metaErr.code !== undefined) {
    const code = Number(metaErr.code);
    const reason = `Meta error ${code}: ${metaErr.error_user_msg || metaErr.error_user_title || metaErr.message || "unknown"}`;
    if (RETRY_CODES.has(code)) return { kind: "RETRY", code, reason };
    if (RATE_LIMIT_CODES.has(code)) return { kind: "RATE_LIMIT", code, reason };
    if (REQUEUE_CODES.has(code)) return { kind: "REQUEUE", code, reason };
    if (RECIPIENT_CODES.has(code)) return { kind: "RECIPIENT", code, reason };
    if (PROBE_CODES.has(code)) return { kind: "PROBE", code, reason };
    if (SYSTEMIC_CODES.has(code)) return { kind: "SYSTEMIC", code, reason };
    // An unknown code that Meta answered with: Meta processed the request and
    // refused it, so it wasn't delivered. Treated like a parameter problem —
    // checked against the next recipients rather than pausing or burning all.
    return { kind: "PROBE", code, reason };
  }
  if (err?.response) {
    // An HTTP answer without Meta's error body (a proxy 502, an HTML page):
    // can't tell whether Meta acted on it.
    return { kind: "AMBIGUOUS", code: null, reason: `HTTP ${err.response.status} without a Meta error` };
  }
  if (!err?.isAxiosError) {
    // Thrown before any HTTP request (building the payload): never sent.
    return { kind: "PROBE", code: null, reason: err?.message || "Could not build the message" };
  }
  if (err?.code && NEVER_SENT_NET_CODES.has(err.code)) {
    return { kind: "RETRY", code: null, reason: `Network: ${err.code}` };
  }
  // Timeouts, ECONNRESET, socket hang up — the request may have been sent.
  return { kind: "AMBIGUOUS", code: null, reason: `Network: ${err?.code || err?.message || "unknown"}` };
}

module.exports = { classifySendError };
