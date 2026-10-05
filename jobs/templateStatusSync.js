const cron = require("node-cron");
const { syncSubmittedTemplates } = require("../utils/templateStatus");

// Backstop for the message_template_status_update webhook: if Meta's webhook
// never reaches us (tunnel down in dev, app unpublished), approvals are still
// picked up within 5 minutes. A no-op when nothing is SUBMITTED.
function startTemplateStatusSync() {
  cron.schedule("*/5 * * * *", async () => {
    try {
      await syncSubmittedTemplates();
    } catch (err) {
      console.error("[Templates] status sync failed:", err.message);
    }
  });
  console.log("[Templates] status sync started (every 5 min)");
}

module.exports = { startTemplateStatusSync };
