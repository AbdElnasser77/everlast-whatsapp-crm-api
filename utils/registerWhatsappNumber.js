/**
 * Bring a new WhatsApp Cloud API number from "Pending" to "Connected".
 *
 * A number added to a WABA in WhatsApp Manager is NOT usable yet — it sits at
 * status PENDING until it is (a) verified, proving you control the line, and
 * (b) *registered* against the Cloud API with a 6-digit two-step PIN. Step (b)
 * has no button in the UI; it only exists as an API call, which is why Meta
 * tells you to "register this phone number using the registration API".
 *
 * Usage (from the API project root):
 *   npm run wa:number status
 *   npm run wa:number status       --phone=<id>
 *   npm run wa:number request-code --phone=<id> [SMS|VOICE]
 *   npm run wa:number verify-code  --phone=<id> 123456
 *   npm run wa:number register     --phone=<id> 123456
 *
 * `--phone=<id>` targets a number that isn't in config.env yet — the usual
 * case while setting a new one up. It is a flag rather than an env var on
 * purpose: `VAR=x cmd` is bash-only syntax that silently does nothing in
 * cmd.exe/PowerShell, which would send a mutating call to whatever number
 * config.env happens to hold — i.e. production.
 *
 * For that same reason every MUTATING command (request-code / verify-code /
 * register) REQUIRES an explicit --phone. Only the read-only `status` falls
 * back to config.env. Re-registering the number already in config.env
 * additionally needs --force, so a live number can't be disturbed by a typo.
 */
const axios = require("axios");

// dotenv only fills vars that aren't already set, so a real environment
// override on the command line still wins over config.env.
require("dotenv").config({ path: "./config.env" });

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";
const CONFIGURED_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const argv = process.argv.slice(2);

// `npm run` steals --flags as its own config before forwarding argv (you get
// "Unknown cli config" and the flag never reaches us), so the bare `phone=<id>`
// form is accepted too. That one survives npm, cmd.exe and bash alike.
const flag = (name) => {
  const hit = argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`) || a.startsWith(`${name}=`),
  );
  if (hit === undefined) return undefined;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : true;
};
const positional = argv.filter((a) => !a.startsWith("--") && !/^[a-zA-Z]+=/.test(a));

const MUTATING = ["request-code", "verify-code", "register"];
const PHONE_NUMBER_ID = typeof flag("phone") === "string" ? flag("phone") : CONFIGURED_ID;

// A System User token only reaches WABAs explicitly assigned to it, so setting
// up a number on a NEW WABA usually needs a different token than the one the
// CRM sends with. --token lets you pass that one for the one-off setup calls
// without touching config.env.
const ACCESS_TOKEN =
  typeof flag("token") === "string" ? flag("token") : process.env.WHATSAPP_ACCESS_TOKEN;

// Meta's own `error.message` is always printed; these add the "what do I
// actually do about it" half, which the raw message consistently omits.
const HINTS = {
  133005: "Wrong two-step PIN. If this number ever had two-step verification enabled (even on the consumer WhatsApp app), you must reuse THAT pin. Otherwise disable two-step on the number first.",
  133006: "Number isn't verified yet. Run `request-code` then `verify-code` before `register`.",
  133008: "Too many registration attempts — Meta rate-limited this number. Wait before retrying (can be several hours).",
  133009: "Too many incorrect PIN guesses. Wait ~30 minutes before trying again.",
  133010: "Number is not registered. Run `register` to complete setup.",
  133015: "Number is mid-deregistration from a previous account. Wait ~5 minutes and retry.",
  133016: "This number is still active on another WhatsApp account. Fully delete it from the WhatsApp/WhatsApp Business phone app first, wait ~5 minutes, then retry.",
  100: "This token has no access to that number's WABA. A System User only reaches WABAs explicitly ASSIGNED to it — `<all>` in its scopes means 'all assigned assets', not every WABA you own. Fix: Business Settings > Users > System Users > your user > Add Assets > WhatsApp Accounts > tick the new WABA > Full control. Or pass the new WABA's own token with --token=<tok> (App Dashboard > WhatsApp > API Setup).",
  190: "Access token is invalid or expired. Temporary dashboard tokens die after 24h — generate a System User token instead.",
};

// Meta reuses code 100 for wildly different problems; the subcode is the part
// that actually identifies the failure, so it is consulted first.
const SUBCODE_HINTS = {
  2593005: "The number still needs SMS/voice verification, whatever code_verification_status reports. Run `request-code` then `verify-code` on THIS number, then register.",
  2593002: "The number is already registered to another WABA. Deregister it there first.",
};

const call = async (method, path, body) => {
  try {
    const { data } = await axios({
      method,
      url: `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}${path}`,
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      ...(method === "get" ? { params: body } : { data: body }),
      timeout: 30_000,
    });
    return data;
  } catch (err) {
    const e = err.response?.data?.error;
    if (!e) throw err;
    const code = e.code;
    const detail = e.error_user_msg || e.error_data?.details;
    console.error(`\n✗ Meta rejected the call (code ${code}${e.error_subcode ? `/${e.error_subcode}` : ""})`);
    console.error(`  ${e.message}`);
    if (detail) console.error(`  ${detail}`);
    const hint = SUBCODE_HINTS[e.error_subcode] || HINTS[code];
    if (hint) console.error(`\n  → ${hint}`);
    process.exit(1);
  }
};

const status = async () => {
  const d = await call("get", "", {
    fields: "display_phone_number,verified_name,status,code_verification_status,name_status,quality_rating,platform_type",
  });
  console.log("\nNumber   :", d.display_phone_number || "(none yet)");
  console.log("Name     :", d.verified_name || "(none)", `[${d.name_status || "—"}]`);
  console.log("Status   :", d.status || "UNKNOWN");
  console.log("Verified :", d.code_verification_status || "UNKNOWN");
  console.log("Quality  :", d.quality_rating || "—");
  console.log("Platform :", d.platform_type || "—");

  if (d.status === "CONNECTED") {
    console.log("\n✓ This number is live and can send messages.");
  } else if (d.code_verification_status !== "VERIFIED") {
    console.log("\n→ Not verified yet. Next: `request-code`, then `verify-code <otp>`.");
  } else {
    console.log("\n→ Verified but not registered. Next: `register <6-digit-pin>`.");
  }
};

const main = async () => {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.error("Missing WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN.");
    process.exit(1);
  }
  const [cmd, arg] = positional;

  // A mutating call that falls back to config.env would target the live
  // production number. Demand the operator name the number out loud.
  if (MUTATING.includes(cmd) && typeof flag("phone") !== "string") {
    console.error(`\n\u2717 \`${cmd}\` requires an explicit --phone=<id>.`);
    console.error("  Refusing to guess: config.env currently points at " +
      `${CONFIGURED_ID}, which is probably your live number.`);
    console.error(`\n  e.g.  npm run wa:number ${cmd} --phone=<new-id> ${arg || "<arg>"}`);
    process.exit(1);
  }

  const isConfigured = PHONE_NUMBER_ID === CONFIGURED_ID;
  console.log(`Acting on phone number id ${PHONE_NUMBER_ID}` +
    `${isConfigured ? "  ⚠ THIS IS THE NUMBER IN config.env" : ""} (${API_VERSION})`);

  // Re-registering a number that is already CONNECTED is never what you want
  // by accident, and each wrong PIN counts toward a lockout (error 133009).
  if (cmd === "register" && isConfigured && flag("force") !== true) {
    console.error("\n\u2717 That is the number config.env is using in production.");
    console.error("  Re-registering it risks a PIN lockout for no benefit.");
    console.error("  If you genuinely mean it, add --force.");
    process.exit(1);
  }

  switch (cmd) {
    case "status":
      return status();

    case "request-code": {
      const method = (arg || "SMS").toUpperCase();
      await call("post", "/request_code", { code_method: method, language: "en_US" });
      console.log(`\n✓ Code requested via ${method}. Then: verify-code <6-digit code>`);
      console.log("  Note: a landline can't receive SMS — use VOICE for those.");
      return;
    }

    case "verify-code": {
      if (!arg) return console.error("Pass the 6-digit code: verify-code 123456");
      await call("post", "/verify_code", { code: arg });
      console.log("\n✓ Ownership verified. Now run: register <6-digit-pin>");
      return;
    }

    case "register": {
      if (!/^\d{6}$/.test(arg || "")) {
        return console.error("Pass a 6-digit PIN you choose, e.g: register 000000");
      }
      await call("post", "/register", { messaging_product: "whatsapp", pin: arg });
      console.log("\n✓ Registered. Save this PIN — you need it to re-register later.");
      console.log("  Confirming status...");
      return status();
    }

    default:
      console.log("\nCommands: status | request-code [SMS|VOICE] | verify-code <code> | register <pin>");
  }
};

main();
