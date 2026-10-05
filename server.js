require("./config/env");
const http = require("http");
const app = require("./app");
const connectDB = require("./config/database");
const { initSocket } = require("./utils/socket");
const { startCampaignScheduler } = require("./jobs/campaignScheduler");
const { startTemplateStatusSync } = require("./jobs/templateStatusSync");
const whatsappNumbers = require("./utils/whatsappNumbers");
const prisma = require("./config/prisma");

const server = http.createServer(app);
initSocket(server);

connectDB().then(async () => {
  // Load the numbers and check each one's token BEFORE accepting traffic. A
  // missing token has to be loud at startup, not discovered when a campaign
  // fails at 2am. Warmup never throws — one dead token must not take down the
  // other numbers with it.
  await whatsappNumbers.warmup().catch((err) => {
    console.error("[WhatsApp] Failed to load numbers:", err.message);
  });

  server.listen(process.env.PORT, () => {
    console.log(`Server running on port ${process.env.PORT}`);
    startCampaignScheduler();
    startTemplateStatusSync();
  });
});

const shutdown = async (signal) => {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await prisma.$disconnect();
    console.log("Database disconnected");
    process.exit(0);
  });
  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Promise Rejection:", reason);
});
