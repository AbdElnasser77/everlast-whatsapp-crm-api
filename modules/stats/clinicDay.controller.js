const axios = require("axios");

// ─── GET /api/stats/clinic-day?date=YYYY-MM-DD ───────────────────────────────
// Proxies the n8n "Clinic day board" (Dok32 appointments) so the browser never
// talks to n8n directly: the webhook secret stays on the server and only
// logged-in users with clinic:read can see patient appointments.
// n8n returns a full HTML page; it goes back as { html } because the frontend's
// apiFetch always parses JSON.
const getClinicDay = async (req, res) => {
  const url = process.env.N8N_CLINIC_DASHBOARD_URL;
  if (!url) {
    return res.status(503).json({ success: false, message: "Clinic dashboard is not configured" });
  }

  const { date } = req.query;
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ success: false, message: "date must be YYYY-MM-DD" });
  }

  const secret = process.env.N8N_WEBHOOK_SECRET;
  try {
    const upstream = await axios.get(url, {
      params: date ? { date } : undefined,
      headers: secret ? { "X-Webhook-Secret": secret } : undefined,
      timeout: 30000,
      responseType: "text",
      transformResponse: (body) => body,
    });
    return res.json({ success: true, data: { html: upstream.data } });
  } catch (err) {
    const status = err.response?.status;
    console.error(`[clinic-day] n8n request failed${status ? ` (HTTP ${status})` : ""}: ${err.message}`);
    return res.status(502).json({
      success: false,
      message: status === 404
        ? "The n8n clinic dashboard workflow is not active"
        : "Could not load the clinic dashboard from n8n",
    });
  }
};

module.exports = { getClinicDay };
