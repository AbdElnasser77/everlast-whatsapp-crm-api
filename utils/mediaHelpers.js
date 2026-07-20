// Shared between the ad-hoc chat upload endpoint (modules/media) and the
// persistent Media Library (modules/media-library) so the two never drift on
// what file types/sizes are accepted or how a mimetype maps to this app's
// messageType.
const ALLOWED_MIMETYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/3gpp",
  "audio/aac", "audio/mpeg", "audio/ogg", "audio/opus", "audio/amr",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB

const getMessageType = (mimetype) => {
  if (mimetype.startsWith("image/")) return "IMAGE";
  if (mimetype.startsWith("video/")) return "VIDEO";
  if (mimetype.startsWith("audio/")) return "AUDIO";
  return "DOCUMENT";
};

const mediaFileFilter = (req, file, cb) => {
  if (ALLOWED_MIMETYPES.includes(file.mimetype)) cb(null, true);
  else cb(new Error(`File type ${file.mimetype} is not supported`));
};

module.exports = { ALLOWED_MIMETYPES, MAX_FILE_SIZE, getMessageType, mediaFileFilter };
