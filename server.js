require("./config/env");
const http = require("http");
const app = require("./app");
const connectDB = require("./config/database");
const { initSocket } = require("./utils/socket");
const { startCampaignScheduler } = require("./jobs/campaignScheduler");
const { beginShutdown } = require("./modules/campaigns/campaign.controller");
const { startTemplateStatusSync } = require("./jobs/templateStatusSync");
const { startWebhookRecovery } = require("./jobs/webhookRecovery");
const { startNumberQualityWatch } = require("./jobs/numberQualityWatch");
const { startFollowUpReminders } = require("./jobs/followUpReminders");
const { loadSettings } = require("./utils/appSettings");
const whatsappNumbers = require("./utils/whatsappNumbers");
const prisma = require("./config/prisma");

const server = http.createServer(app);
initSocket(server);

connectDB().then(async () => {
  // Load the numbers and check each one's token BEFORE accepting traffic. A
  // missing token has to be loud at startup, not discovered when a campaign
  // fails at 2am. Warmup never throws — one dead token must not take down the
  // other numbers with it.
  // Quiet hours and campaign limits saved in Settings, before anything sends.
  await loadSettings().catch((err) => console.error("[Settings] Failed to load:", err.message));
  await whatsappNumbers.warmup().catch((err) => {
    console.error("[WhatsApp] Failed to load numbers:", err.message);
  });

  server.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
    startCampaignScheduler();
    startTemplateStatusSync();
    startWebhookRecovery();
    startNumberQualityWatch();
    startFollowUpReminders();
  });
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down gracefully`);
  // Force exit if graceful shutdown hangs. Long enough for campaign sends that
  // are already with Meta to be written down (see beginShutdown).
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30_000).unref();
  // Stop campaign loops first: no new recipients are picked up, in-flight
  // sends finish and are recorded, and the campaigns stay RUNNING for the next
  // process to carry on. Killing them mid-send is what leaves "Not confirmed".
  const drained = await beginShutdown(25_000);
  if (!drained) console.error("Campaign sends still in flight at shutdown — they will be settled as 'Not confirmed'");
  server.close(async () => {
    await prisma.$disconnect();
    console.log("Database disconnected");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Promise Rejection:", reason);
});
