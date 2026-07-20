const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const imageSize = require("image-size");

// Cloudflare R2 is S3-compatible, so we drive it with the AWS S3 SDK pointed at
// R2's endpoint. Unlike Cloudinary (a media platform), R2 is plain object
// storage: it does NOT generate a public URL, detect image dimensions, or
// derive a format for us — this module fills those gaps so the rest of the app
// keeps the same shape it had with Cloudinary ({ url, publicId/key, format,
// bytes, width, height }).

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
} = process.env;

let client = null;
function getClient() {
  if (client) return client;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 is not configured (missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return client;
}

// mimetype -> file extension, so keys look like real files and R2 serves them
// with a sensible name. Falls back to the subtype (e.g. "image/foo" -> "foo").
const EXT_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/amr": "amr",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function extFor(mimetype) {
  return EXT_BY_MIME[mimetype] || (mimetype.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "");
}

// R2 buckets are private by default; the app relies on public-access (r2.dev or
// a custom domain) being enabled so stored URLs never expire — chat history and
// WhatsApp's media fetch both depend on that.
function publicUrl(key) {
  if (!R2_PUBLIC_URL) throw new Error("R2_PUBLIC_URL is not configured");
  return `${R2_PUBLIC_URL.replace(/\/+$/, "")}/${key}`;
}

// Uploads a buffer and returns a Cloudinary-shaped result so callers barely
// change. `width`/`height` are best-effort for images only (Cloudinary gave
// these for free; here we read them from the bytes and null out on failure).
async function uploadBuffer({ buffer, mimetype, folder }) {
  if (!R2_BUCKET_NAME) throw new Error("R2_BUCKET_NAME is not configured");

  const key = `${folder.replace(/\/+$/, "")}/${crypto.randomUUID()}.${extFor(mimetype)}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }),
  );

  let width = null;
  let height = null;
  if (mimetype.startsWith("image/")) {
    try {
      const dims = imageSize(buffer);
      width = dims.width ?? null;
      height = dims.height ?? null;
    } catch {
      // Non-fatal: some formats (e.g. certain webp/heic) can't be measured.
    }
  }

  return {
    url: publicUrl(key),
    key,
    format: extFor(mimetype),
    bytes: buffer.length,
    width,
    height,
  };
}

async function deleteObject(key) {
  if (!R2_BUCKET_NAME) throw new Error("R2_BUCKET_NAME is not configured");
  await getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
}

module.exports = { uploadBuffer, deleteObject, publicUrl };
