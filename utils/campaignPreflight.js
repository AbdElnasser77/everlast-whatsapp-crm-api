// Can this campaign be sent right now? One answer for every path that starts
// or continues a send — submit, approve, send-now, resume, the scheduler and
// the send loop itself — so a template deleted, paused or disabled after the
// campaign was created is caught before anything goes to Meta, with a reason
// a person can act on, instead of as a Meta error halfway through the list.

const prisma = require("../config/prisma");
const AppError = require("./AppError");
const numbers = require("./whatsappNumbers");
const { buildTemplateSend } = require("./templateSend");
const { getSetting } = require("./appSettings");

// Meta health states that stop campaigns when Settings → Campaign safety says
// so. A flagged / restricted / banned account always counts.
const BAD_META_STATUS = new Set(["FLAGGED", "RESTRICTED", "BANNED"]);
function qualityProblem(number) {
  const safety = getSetting("campaignSafety");
  if (!safety.qualityAutoPause) return null;
  const badRatings = safety.qualityPauseAt === "RED" ? ["RED"] : ["YELLOW", "RED"];
  if (number.qualityRating && badRatings.includes(number.qualityRating)) {
    return `The number's Meta quality rating is ${number.qualityRating}. Campaigns are held until it recovers (or an admin turns off "pause on low quality" in Settings).`;
  }
  if (number.metaStatus && BAD_META_STATUS.has(number.metaStatus)) {
    return `Meta marked this number ${number.metaStatus}. Campaigns are held until that is resolved.`;
  }
  return null;
}

// Throws an AppError (409) explaining the first problem found.
function assertCampaignSendable({ template, number }) {
  if (!number || !number.isActive) {
    throw new AppError("The WhatsApp number for this campaign is deactivated", 409, "NUMBER_INACTIVE");
  }
  const quality = qualityProblem(number);
  if (quality) throw new AppError(quality, 409, "NUMBER_QUALITY");
  if (!template || !template.isActive) {
    throw new AppError("This campaign's template was deleted. Pick another template (as a new campaign) to send it.", 409, "TEMPLATE_DELETED");
  }
  if (template.approvalStatus === "PAUSED") {
    throw new AppError(`Meta paused the template "${template.name}" (usually low quality or too many blocks). It can't be sent until Meta reinstates it.`, 409, "TEMPLATE_PAUSED");
  }
  if (template.approvalStatus === "DISABLED") {
    throw new AppError(`Meta disabled the template "${template.name}". It can't be sent any more.`, 409, "TEMPLATE_DISABLED");
  }
  if (template.approvalStatus !== "APPROVED") {
    throw new AppError(`The template "${template.name}" isn't approved by Meta`, 409, "TEMPLATE_NOT_APPROVED");
  }
  // Wrong business account: Meta would answer "template doesn't exist".
  numbers.assertTemplateUsable(template, number);
  // A campaign must go out as an approved Meta template. Anything else would
  // fall back to a plain message, which Meta only accepts inside a 24-hour
  // window — i.e. it would fail for almost everyone.
  if (!buildTemplateSend(template, { name: "" }).needsMetaTemplate) {
    throw new AppError(`The template "${template.name}" isn't an approved Meta template`, 409, "TEMPLATE_NOT_APPROVED");
  }
}

const isTemplateProblem = (code) => typeof code === "string" && code.startsWith("TEMPLATE_");

// Loads the campaign's template and number and checks them.
async function checkCampaignSendable(campaignId) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { template: true, whatsappNumber: true },
  });
  if (!campaign) throw new AppError("Campaign not found", 404);
  assertCampaignSendable({ template: campaign.template, number: campaign.whatsappNumber });
  return campaign;
}

module.exports = { assertCampaignSendable, checkCampaignSendable, isTemplateProblem, qualityProblem };
