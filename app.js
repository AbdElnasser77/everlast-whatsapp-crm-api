const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Behind a reverse proxy / tunnel (serveo, nginx, Caddy) that sets X-Forwarded-For.
// Trust exactly ONE proxy hop so express-rate-limit can identify the real client IP.
// Do NOT use `true` (trust all) — clients could spoof X-Forwarded-For to dodge rate limits.
app.set("trust proxy", 1);

// Security headers. CSP is disabled because this process serves a JSON API
// (and Swagger UI, which needs inline assets), not first-party HTML pages.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
  // The browser can only READ a response header that is explicitly exposed.
  // The client compares this echo against the number it currently has selected
  // and discards any response that arrives after a switch, so without this the
  // whole stale-response guard silently does nothing.
  exposedHeaders: ["X-WhatsApp-Number-Id"],
}));
app.use(cookieParser());
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Rate limiter for auth endpoints — prevents brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { success: false, message: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for webhook — prevents flood attacks while allowing Meta retries
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  message: { success: false, message: "Too many webhook requests" },
  standardHeaders: true,
  legacyHeaders: false,
});

// Only expose API docs outside production — they describe every endpoint and
// shouldn't be publicly browsable on the live server.
if (process.env.NODE_ENV !== "production") {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: { persistAuthorization: true },
  }));
}

app.use("/api/auth", authLimiter, require("./modules/auth/auth.routes"));
app.use("/api/users", require("./modules/users/user.routes"));
app.use("/api/customers", require("./modules/customers/customer.routes"));
app.use("/api/lists", require("./modules/lists/list.routes"));
app.use("/api/segments", require("./modules/segments/segment.routes"));
app.use("/api/conversations", require("./modules/conversations/conversation.routes"));
app.use("/api/messages", require("./modules/messages/message.routes"));
app.use("/api/media", require("./modules/media/media.routes"));
app.use("/api/media-library", require("./modules/media-library/mediaLibrary.routes"));
app.use("/api/webhooks", webhookLimiter, require("./modules/webhooks/webhook.routes"));
app.use("/api/audit", require("./modules/audit/audit.routes"));
app.use("/api/stats", require("./modules/stats/stats.routes"));
app.use("/api/templates", require("./modules/templates/template.routes"));
app.use("/api/campaigns", require("./modules/campaigns/campaign.routes"));
app.use("/api/whatsapp", require("./modules/whatsapp-status/whatsappStatus.routes"));
// Dev-only tools (message/cost tracker). Never mounted in production.
if (process.env.NODE_ENV !== "production") {
  app.use("/api/dev", require("./modules/dev/dev.routes"));
}

app.use(errorHandler);

module.exports = app;
