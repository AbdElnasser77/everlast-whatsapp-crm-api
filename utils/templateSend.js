// Single source of truth for turning a Template + Customer into the arguments
// sendWhatsAppMessage expects, plus the JSON blob the app stores as a message's
// content.
//
// This exists so a test send and a real campaign send are built by the SAME
// code. If the two ever drift, a test send stops being evidence about the real
// one — which is the whole point of having a test send.

const { buildTemplateParams, resolveNamedVars } = require("./templateVars");

/**
 * @param template a Template row
 * @param customer a Customer row (or any { name } shape, for a sample render)
 * @param agent    the acting user, for {{agent_name}} — null in campaigns
 * @param opts.cardPayload  (cardIndex, button) => the payload a carousel card's
 *   quick-reply tap reports back. Default "cb:<card>:<button id>", which is how
 *   a flow's Start step tells WHICH card was tapped (titles often repeat —
 *   every card may say "Interested"). Flows pass their own run-scoped payload.
 */
const defaultCardPayload = (i, b) => `cb:${i}:${b.id}`;

const buildTemplateSend = (template, customer, agent = null, { cardPayload = defaultCardPayload } = {}) => {
  const resolvedBody = resolveNamedVars(template.body, customer, agent);
  const resolvedHeader =
    template.headerType === "TEXT" && template.header
      ? resolveNamedVars(template.header, customer, agent)
      : null;

  const hasButtons =
    template.buttons && Array.isArray(template.buttons) && template.buttons.length > 0;

  // A Meta-approved TEMPLATE send is the only shape that can open a new
  // conversation. Anything else goes out as an ad-hoc INTERACTIVE/TEXT
  // message, which Meta only accepts inside an open 24-hour window.
  const needsMetaTemplate =
    template.category !== "GENERAL" &&
    template.approvalStatus === "APPROVED" &&
    !!template.metaTemplateName;

  const messageType = needsMetaTemplate ? "TEMPLATE" : hasButtons ? "INTERACTIVE" : "TEXT";

  const cards = Array.isArray(template.cards) && template.cards.length ? template.cards : null;

  const templateContent = JSON.stringify({
    headerType: template.headerType,
    header: resolvedHeader || undefined,
    headerMediaUrl: template.headerMediaUrl || undefined,
    body: resolvedBody,
    footer: template.footer || undefined,
    buttons: hasButtons ? template.buttons : undefined,
    // Carousel: what the inbox renders as swipeable cards.
    cards: cards || undefined,
  });

  // Positional params matching the submitted Meta template (order of appearance).
  const templateVariables = buildTemplateParams(template.body, customer, agent);
  // The header's own positional value (at most one), sent as a header component.
  const headerVariables =
    template.headerType === "TEXT" && template.header ? buildTemplateParams(template.header, customer, agent) : [];

  return {
    resolvedBody,
    resolvedHeader,
    hasButtons,
    needsMetaTemplate,
    messageType,
    templateContent,
    templateVariables,
    headerVariables,
    // Spread straight into sendWhatsAppMessage alongside `to`.
    sendArgs: {
      content: resolvedBody,
      messageType,
      buttons: hasButtons ? template.buttons : null,
      headerType: template.headerType,
      header: resolvedHeader,
      headerMediaUrl: template.headerMediaUrl || null,
      footer: template.footer || null,
      templateName: template.metaTemplateName,
      language: template.language,
      templateVariables,
      headerVariables,
      // Every card's media must be sent again at send time (Meta's rule), and
      // each quick reply gets the payload its tap will report.
      carouselCards: cards
        ? cards.map((c, i) => ({
            mediaType: c.mediaType,
            mediaUrl: c.mediaUrl,
            quickReplyPayloads: c.buttons.map((b) => (b.type === "QUICK_REPLY" ? cardPayload(i, b) : null)),
          }))
        : null,
    },
  };
};

module.exports = { buildTemplateSend };
