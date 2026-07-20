const cloudinary = require("./cloudinary");

// Cloudinary-backed implementation of the shared storage interface
// (see utils/storage.js). Kept alongside the R2 implementation so the app can
// fall back to Cloudinary while R2 is being set up / verified.

const resourceTypeFor = (mimetype) => {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("audio/")) return "video"; // Cloudinary uses "video" for audio
  return "raw"; // documents (pdf, docx, etc.)
};

// Returns the same shape as utils/r2.js's uploadBuffer:
// { url, key, format, bytes, width, height }. `key` is Cloudinary's public_id,
// which callers persist as `publicId` (and pass back to deleteObject).
async function uploadBuffer({ buffer, mimetype, folder }) {
  const resource_type = resourceTypeFor(mimetype);
  const options = { resource_type, folder };
  // WhatsApp stickers are (often animated) WebP; without these Cloudinary can
  // reject them with "Invalid webp file". Harmless for static WebP too.
  if (mimetype === "image/webp") {
    options.flags = ["animated"];
    options.format = "webp";
  }
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      options,
      (err, res) => (err ? reject(err) : resolve(res)),
    );
    stream.end(buffer);
  });

  return {
    url: result.secure_url,
    key: result.public_id,
    format: result.format ?? null,
    bytes: result.bytes ?? buffer.length,
    width: result.width ?? null,
    height: result.height ?? null,
  };
}

async function deleteObject({ key, mediaType }) {
  const resource_type = mediaType === "IMAGE" ? "image" : mediaType === "DOCUMENT" ? "raw" : "video";
  await cloudinary.uploader.destroy(key, { resource_type });
}

module.exports = { uploadBuffer, deleteObject };
