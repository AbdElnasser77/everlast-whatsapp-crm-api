const r2 = require("./r2");
const cloudinaryStorage = require("./cloudinaryStorage");

// Single entry point for file storage so the rest of the app doesn't care which
// backend is active. Controlled by STORAGE_PROVIDER (default "cloudinary"):
//
//   STORAGE_PROVIDER=cloudinary  -> Cloudinary (the current/backup provider)
//   STORAGE_PROVIDER=r2          -> Cloudflare R2
//
// This lets us keep Cloudinary working while R2 is set up and verified, then
// flip a single env var to cut over — and flip back instantly if anything's
// wrong. Both providers return the same shape from uploadBuffer:
//   { url, key, format, bytes, width, height }
// where `key` is what callers persist as `publicId` and pass back to delete.

const provider = () =>
  (process.env.STORAGE_PROVIDER || "cloudinary").toLowerCase() === "r2"
    ? "r2"
    : "cloudinary";

function activeProvider() {
  return provider();
}

async function uploadBuffer(opts) {
  return provider() === "r2"
    ? r2.uploadBuffer(opts)
    : cloudinaryStorage.uploadBuffer(opts);
}

// mediaType (IMAGE/VIDEO/AUDIO/DOCUMENT) is only needed by Cloudinary, which
// requires the resource_type to delete; R2 deletes purely by key.
async function deleteObject({ key, mediaType }) {
  return provider() === "r2"
    ? r2.deleteObject(key)
    : cloudinaryStorage.deleteObject({ key, mediaType });
}

module.exports = { uploadBuffer, deleteObject, activeProvider };
