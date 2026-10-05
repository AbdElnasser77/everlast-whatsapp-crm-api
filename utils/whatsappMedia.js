const axios = require("axios");
const prisma = require("../config/prisma");
const storage = require("./storage");
const { emitToNumber } = require("./socket");
const numbers = require("./whatsappNumbers");

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Downloads a message's media from Meta by its media id, uploads it to the
// active storage provider, persists the resulting permanent URL on the message,
// and notifies the frontend. Returns the stored URL.
//
// Meta's per-media-id download URL is only valid for ~5 minutes, but the media
// *id itself* stays downloadable for as long as Meta retains the file (days).
// So a failed background upload can always be recovered later by calling this
// again with the stored mediaId — that's what makes "just redownload it" work.
//
// `whatsappNumberId` is optional: the webhook path already knows it, while the
// on-demand recovery path does not. When absent it is resolved from the
// message's conversation, which makes it impossible to call this with a token
// that cannot reach the media — a media id issued to one WABA is not readable
// with another WABA's token.
async function fetchAndStoreMedia({ messageId, mediaId, messageType, whatsappNumberId = null }) {
  let numberId = whatsappNumberId;
  if (!numberId) {
    const row = await prisma.message.findUnique({
      where: { id: messageId },
      select: { conversation: { select: { whatsappNumberId: true } } },
    });
    numberId = row?.conversation?.whatsappNumberId ?? null;
  }
  if (!numberId) throw new Error(`Cannot resolve a WhatsApp number for message ${messageId}`);

  const { accessToken } = await numbers.getCredentials(numberId);

  // 1. Fresh temporary download URL + the file's real mimetype from Meta.
  const metaRes = await axios.get(
    `https://graph.facebook.com/${API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const downloadUrl = metaRes.data?.url;
  if (!downloadUrl) throw new Error("Meta did not return a download URL");
  const mimetype = metaRes.data?.mime_type
    || (messageType === "STICKER" ? "image/webp" : "application/octet-stream");

  // 2. Download the bytes (WhatsApp media is <=16MB, safe to buffer).
  const fileRes = await axios.get(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: "arraybuffer",
  });
  const buffer = Buffer.from(fileRes.data);

  // 3. Upload to the active storage provider.
  const result = await storage.uploadBuffer({ buffer, mimetype, folder: "everlast-crm/received" });

  // 4. Persist the permanent URL and let the frontend swap the placeholder.
  await prisma.message.update({ where: { id: messageId }, data: { mediaUrl: result.url } });
  try {
    emitToNumber(numberId, "message.media_ready", { messageId, mediaUrl: result.url });
  } catch {
    // Socket not ready (e.g. called from a script) — non-fatal.
  }

  // Return the bytes too so an on-demand caller can stream them back in the same
  // request (same-origin, no CORS) instead of redirecting to storage.
  return { url: result.url, buffer, mimetype };
}

// Same as fetchAndStoreMedia but retries a few times on transient failures
// (Meta hiccup, network blip, storage timeout). Used by the fire-and-forget
// webhook path so a single flaky moment doesn't strand the media forever.
async function fetchAndStoreMediaWithRetry(args, { attempts = 3, delayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchAndStoreMedia(args);
    } catch (err) {
      lastErr = err;
      if (i < attempts) await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

module.exports = { fetchAndStoreMedia, fetchAndStoreMediaWithRetry };
