// Bootstraps the WhatsAppNumber table. Idempotent — upserts by phoneNumberId, so
// it is safe to re-run after editing config.env and is the supported way to add
// a number (tokens live in the environment, so adding one needs a deploy).
//
// Two sources, in order:
//   1. WHATSAPP_NUMBERS — a JSON array, the multi-number form:
//        WHATSAPP_NUMBERS=[{"label":"Clinic","phoneNumberId":"...","wabaId":"...",
//                           "displayPhoneNumber":"+971...","tokenEnvKey":"WHATSAPP_TOKEN_CLINIC",
//                           "isDefault":true}]
//   2. The legacy single-number vars (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_WABA_ID
//      / WHATSAPP_ACCESS_TOKEN), so an existing install migrates with no config
//      change at all.

require("../config/env");
const prisma = require("../config/prisma");
const { TOKEN_ENV_KEY_RE } = require("./whatsappNumbers");

function parseConfigured() {
  const raw = process.env.WHATSAPP_NUMBERS;

  if (raw && raw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`WHATSAPP_NUMBERS is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("WHATSAPP_NUMBERS must be a non-empty JSON array");
    }
    return parsed;
  }

  // Legacy fallback.
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const wabaId = process.env.WHATSAPP_WABA_ID;
  if (!phoneNumberId || !wabaId) {
    throw new Error(
      "Nothing to seed. Set WHATSAPP_NUMBERS, or WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_WABA_ID for the legacy single-number setup.",
    );
  }
  return [
    {
      label: process.env.WHATSAPP_NUMBER_LABEL || "Main",
      phoneNumberId,
      wabaId,
      displayPhoneNumber: process.env.WHATSAPP_DISPLAY_NUMBER || null,
      tokenEnvKey: "WHATSAPP_ACCESS_TOKEN",
      isDefault: true,
    },
  ];
}

function validate(entry, i) {
  const where = `WHATSAPP_NUMBERS[${i}]`;
  for (const field of ["label", "phoneNumberId", "wabaId", "tokenEnvKey"]) {
    if (!entry[field] || typeof entry[field] !== "string") {
      throw new Error(`${where}: "${field}" is required and must be a string`);
    }
  }
  // Same allow-list the resolver enforces at read time. Failing here means a bad
  // value never reaches the database in the first place.
  if (!TOKEN_ENV_KEY_RE.test(entry.tokenEnvKey)) {
    throw new Error(
      `${where}: tokenEnvKey "${entry.tokenEnvKey}" must be WHATSAPP_ACCESS_TOKEN or WHATSAPP_TOKEN_*`,
    );
  }
  if (!process.env[entry.tokenEnvKey]) {
    console.warn(
      `  ! ${entry.label}: ${entry.tokenEnvKey} is not set — the row will be created but cannot send until it is`,
    );
  }
}

const seed = async () => {
  const configured = parseConfigured();
  configured.forEach(validate);

  const defaults = configured.filter((e) => e.isDefault);
  if (defaults.length > 1) {
    throw new Error("Only one number may have isDefault: true");
  }

  const saved = [];
  for (const entry of configured) {
    const data = {
      label: entry.label,
      wabaId: entry.wabaId,
      displayPhoneNumber: entry.displayPhoneNumber || null,
      tokenEnvKey: entry.tokenEnvKey,
      appId: entry.appId || null,
      ...(entry.sendConcurrency ? { sendConcurrency: Number(entry.sendConcurrency) } : {}),
      ...(entry.isActive === false ? { isActive: false } : { isActive: true }),
    };

    // isDefault is applied separately below: a partial unique index allows only
    // one true at a time, so two rows cannot both claim it mid-loop.
    const row = await prisma.whatsAppNumber.upsert({
      where: { phoneNumberId: entry.phoneNumberId },
      update: data,
      create: { ...data, phoneNumberId: entry.phoneNumberId },
    });
    saved.push({ row, isDefault: Boolean(entry.isDefault) });
    console.log(`  ✓ ${row.label} (${row.displayPhoneNumber || row.phoneNumberId}) → WABA ${row.wabaId}`);
  }

  // Clear every default, then set the one — in a transaction, so the partial
  // unique index never sees two rows claiming it.
  const wanted = saved.find((s) => s.isDefault) || saved[0];
  await prisma.$transaction([
    prisma.whatsAppNumber.updateMany({ data: { isDefault: false } }),
    prisma.whatsAppNumber.update({ where: { id: wanted.row.id }, data: { isDefault: true } }),
  ]);
  console.log(`  ✓ default number: ${wanted.row.label}`);

  // Adopt templates left with the empty-string tombstone by the multi-number
  // migration. They predate WABA scoping, so they belong to whichever WABA the
  // default number sends from; until adopted they match no WABA and are
  // invisible everywhere.
  const orphans = await prisma.template.updateMany({
    where: { wabaId: "" },
    data: { wabaId: wanted.row.wabaId },
  });
  if (orphans.count > 0) {
    console.log(`  ✓ adopted ${orphans.count} pre-existing template(s) into WABA ${wanted.row.wabaId}`);
  }

  await prisma.$disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  prisma.$disconnect();
  process.exit(1);
});
