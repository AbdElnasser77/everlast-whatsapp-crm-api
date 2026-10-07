const axios = require("axios");

const getApiVersion = () => process.env.WHATSAPP_API_VERSION || "v19.0";

// Build the "header" object for an ad-hoc INTERACTIVE message. Unlike an
// approved Meta TEMPLATE, an interactive message's header media is just a
// link — no upload/handle needed.
function buildInteractiveHeader(headerType, header, headerMediaUrl) {
  if (headerType === "TEXT" && header) return { type: "text", text: header };
  if (headerType === "IMAGE" && headerMediaUrl) return { type: "image", image: { link: headerMediaUrl } };
  if (headerType === "VIDEO" && headerMediaUrl) return { type: "video", video: { link: headerMediaUrl } };
  if (headerType === "DOCUMENT" && headerMediaUrl) return { type: "document", document: { link: headerMediaUrl, filename: "document" } };
  return null;
}

/**
 * Sends one WhatsApp message.
 *
 * @param number  REQUIRED resolved credentials from utils/whatsappNumbers.js
 *                getCredentials() — { phoneNumberId, accessToken }. Passed in
 *                rather than looked up so this function stays free of DB I/O.
 */
const sendWhatsAppMessage = async ({
  number,
  to,
  content,
  messageType = "TEXT",
  mediaUrl = null,
  buttons = null,
  headerType = null,
  header = null,
  headerMediaUrl = null,
  footer = null,
  templateName = null,
  language = "en_US",
  templateVariables = [],
  headerVariables = [],
  quotedWhatsappMessageId = null,
  // INTERACTIVE list message: { buttonLabel, rows: [{ id, title, description? }] }.
  // Takes precedence over `buttons`. Header may only be text on a list.
  list = null,
  // TEMPLATE carousel: [{ mediaType, mediaUrl, quickReplyPayloads: [payload|null] }]
  carouselCards = null,
  // INTERACTIVE carousel (no template, 24h window only):
  // [{ mediaType, mediaUrl, body?, buttons: [{ type: QUICK_REPLY, id, title } | { type: URL, title, url }] }]
  carousel = null,
}) => {
  // No environment fallback, deliberately. A fallback would mean a call site
  // that forgot to pass `number` keeps silently sending from whichever line the
  // env happens to name — messages going out from the wrong number, with
  // nothing in the logs to say so. Failing loudly is the only safe default.
  if (!number || !number.phoneNumberId || !number.accessToken) {
    throw new Error(
      "sendWhatsAppMessage: `number` is required — pass resolved credentials from whatsappNumbers.getCredentials()",
    );
  }
  const { phoneNumberId, accessToken } = number;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: messageType.toLowerCase(),
    ...(quotedWhatsappMessageId ? { context: { message_id: quotedWhatsappMessageId } } : {}),
  };

  switch (messageType) {
    case "TEXT":
      payload.text = { body: content };
      break;
    case "IMAGE":
      payload.image = { link: mediaUrl, caption: content || "" };
      break;
    case "VIDEO":
      payload.video = { link: mediaUrl, caption: content || "" };
      break;
    case "AUDIO":
      payload.audio = { link: mediaUrl };
      break;
    case "DOCUMENT":
      payload.document = { link: mediaUrl, caption: content || "", filename: content || "document" };
      break;
    case "INTERACTIVE": {
      // WhatsApp's ad-hoc interactive message only supports two button shapes:
      // up to 3 Quick Reply buttons, OR a single CTA URL button. A Call Number
      // button, or a mix of CTA buttons, only renders as real tappable buttons
      // inside an approved Meta TEMPLATE — for an immediate/ad-hoc send we
      // degrade gracefully to plain text lines instead of dropping the info.
      // Not named "list": that would hide the `list` parameter (a list message).
      const btns = buttons || [];
      const interactiveHeader = buildInteractiveHeader(headerType, header, headerMediaUrl);
      const allQuickReply = btns.length > 0 && btns.every((b) => (b.type || "QUICK_REPLY") === "QUICK_REPLY");
      const singleUrlButton = btns.length === 1 && btns[0].type === "URL";

      payload.type = "interactive";
      if (carousel) {
        // Shape from Meta's "interactive media carousel" docs, whose examples
        // give every card type "cta_url", quick-reply cards included.
        payload.interactive = {
          type: "carousel",
          body: { text: content },
          action: {
            cards: carousel.map((c, i) => {
              const key = c.mediaType === "VIDEO" ? "video" : "image";
              const link = c.buttons.find((b) => b.type === "URL");
              return {
                card_index: i,
                type: "cta_url",
                header: { type: key, [key]: { link: c.mediaUrl } },
                ...(c.body && { body: { text: c.body } }),
                action: link
                  ? { name: "cta_url", parameters: { display_text: link.title, url: link.url } }
                  : { buttons: c.buttons.map((b) => ({ type: "quick_reply", quick_reply: { id: b.id, title: b.title } })) },
              };
            }),
          },
        };
      } else if (list) {
        payload.interactive = {
          type: "list",
          ...(headerType === "TEXT" && header && { header: { type: "text", text: header } }),
          body: { text: content },
          ...(footer && { footer: { text: footer } }),
          action: {
            button: list.buttonLabel,
            sections: [{
              rows: list.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description && { description: r.description }) })),
            }],
          },
        };
      } else if (allQuickReply) {
        payload.interactive = {
          type: "button",
          ...(interactiveHeader && { header: interactiveHeader }),
          body: { text: content },
          ...(footer && { footer: { text: footer } }),
          action: { buttons: btns.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        };
      } else if (singleUrlButton) {
        payload.interactive = {
          type: "cta_url",
          ...(interactiveHeader && { header: interactiveHeader }),
          body: { text: content },
          ...(footer && { footer: { text: footer } }),
          action: { name: "cta_url", parameters: { display_text: btns[0].title, url: btns[0].url } },
        };
      } else if (btns.length > 0) {
        const lines = btns.map((b) =>
          b.type === "PHONE_NUMBER" ? `📞 ${b.title}: ${b.phoneNumber}` : b.type === "URL" ? `🔗 ${b.title}: ${b.url}` : `• ${b.title}`
        );
        payload.type = "text";
        payload.text = { body: [content, "", ...lines].join("\n") };
      } else {
        payload.interactive = {
          type: "button",
          ...(interactiveHeader && { header: interactiveHeader }),
          body: { text: content },
          ...(footer && { footer: { text: footer } }),
          action: { buttons: [] },
        };
      }
      break;
    }
    case "TEMPLATE": {
      payload.type = "template";
      const components = [];
      if (["IMAGE", "VIDEO", "DOCUMENT"].includes(headerType) && headerMediaUrl) {
        const key = headerType.toLowerCase();
        components.push({ type: "header", parameters: [{ type: key, [key]: { link: headerMediaUrl } }] });
      } else if (headerType === "TEXT" && headerVariables.length) {
        components.push({ type: "header", parameters: headerVariables.map((v) => ({ type: "text", text: v })) });
      }
      if (templateVariables.length) {
        components.push({ type: "body", parameters: templateVariables.map((v) => ({ type: "text", text: v })) });
      }
      // Static URL/Call/Quick-Reply buttons need no component override at
      // send time — they're already baked into the approved template. A URL
      // button with a dynamic {{1}} placeholder would need one, but that
      // requires resolving the button's own variable (distinct from the body
      // vars) which isn't modeled yet, so it's intentionally left as-is
      // rather than guessing a value.
      if (carouselCards && carouselCards.length) {
        components.push({
          type: "carousel",
          cards: carouselCards.map((c, i) => {
            const key = c.mediaType.toLowerCase();
            return {
              card_index: i,
              components: [
                { type: "header", parameters: [{ type: key, [key]: { link: c.mediaUrl } }] },
                ...c.quickReplyPayloads
                  .map((p, j) => (p ? { type: "button", sub_type: "quick_reply", index: String(j), parameters: [{ type: "payload", payload: p }] } : null))
                  .filter(Boolean),
              ],
            };
          }),
        });
      }
      payload.template = { name: templateName, language: { code: language }, components };
      break;
    }
    default:
      payload.text = { body: content };
  }

  const response = await axios.post(
    `https://graph.facebook.com/${getApiVersion()}/${phoneNumberId}/messages`,
    payload,
    {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      // Fail fast instead of letting one hung request stall the whole campaign loop.
      timeout: 30_000,
    },
  );

  const whatsappMessageId = response.data?.messages?.[0]?.id;
  return { whatsappMessageId };
};

/**
 * Show "typing…" to the customer on their message `messageId` (a wamid).
 * WhatsApp ties this to a read receipt: the message turns blue-ticked now.
 * It lasts up to 25 seconds or until our next message. Only call it when a
 * reply is actually coming (WhatsApp's own guidance).
 */
const sendTypingIndicator = async ({ number, messageId }) => {
  if (!number?.phoneNumberId || !number?.accessToken || !messageId) return;
  await axios.post(
    `https://graph.facebook.com/${getApiVersion()}/${number.phoneNumberId}/messages`,
    { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } },
    { headers: { Authorization: `Bearer ${number.accessToken}`, "Content-Type": "application/json" }, timeout: 10_000 },
  );
};

module.exports = { sendWhatsAppMessage, sendTypingIndicator, getApiVersion };
