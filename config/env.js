const dotenv = require("dotenv");
dotenv.config({ path: "./config.env" });

// WhatsApp numbers now live in the database, so WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_WABA_ID and WHATSAPP_ACCESS_TOKEN are no longer hard requirements —
// they are the bootstrap source for `npm run seed:numbers` and the token behind
// the seeded row. VERIFY_TOKEN and APP_SECRET stay required: both are Meta
// APP-level, shared by every number, and inbound webhooks fail closed without them.
const required = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PORT",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// Only warn about the storage backend that's actually active, so switching
// providers doesn't spam warnings about the unused one.
const storageProvider = (process.env.STORAGE_PROVIDER || "cloudinary").toLowerCase();
const storageVars = storageProvider === "r2"
  ? ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
  : ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];

const recommended = [...storageVars];
for (const key of recommended) {
  if (!process.env[key]) {
    console.warn(`[Config] Warning: ${key} is not set — some features will be unavailable`);
  }
}

// Expose API version so all modules use the same one
process.env.WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";
