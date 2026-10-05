const prisma = require("../../config/prisma");
const { RATES_USD, countryOf, rateFor } = require("../../utils/whatsappPricing");

// Meta error codes worth calling out while testing billing.
const ERROR_HINTS = {
  131042: "Payment problem on the WhatsApp account — check the payment method in WhatsApp Manager → Billing",
  131047: "24-hour window closed — only a template can be sent",
  131026: "Recipient can't receive (not on WhatsApp, old app, or hasn't accepted terms)",
  131049: "Meta held this marketing message back (per-user marketing limit)",
  131050: "Customer stopped marketing messages in WhatsApp — now marked opted out",
  132001: "Template doesn't exist or isn't approved in this language",
  470: "24-hour window closed — only a template can be sent",
};

// Dev-only billing tracker: every outbound message since `since`, with Meta's
// billing verdict and a cost from RATES_USD. Cost is only counted when Meta
// marked the message billable — never guessed from the message type.
const getBilling = async (req, res, next) => {
  try {
    // Any start date (the tracker offers 24h / 7d / 30d / this month / all time).
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 3600 * 1000);
    if (Number.isNaN(since.getTime())) return res.status(400).json({ success: false, message: "Invalid since" });

    const rows = await prisma.message.findMany({
      where: { senderType: "AGENT", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, createdAt: true, content: true, messageType: true, status: true,
        billable: true, pricingCategory: true, pricingType: true, errorCode: true, errorTitle: true,
        whatsappMessageId: true,
        conversation: {
          select: {
            id: true,
            customer: { select: { name: true, phone: true } },
            whatsappNumber: { select: { label: true } },
          },
        },
      },
    });

    const totals = {
      messages: rows.length, sent: 0, delivered: 0, read: 0, failed: 0, pending: 0,
      billable: 0, free: 0, awaitingPricing: 0, noRate: 0, costUsd: 0,
      byCategory: {},
      paymentIssue: false,
    };

    const messages = rows.map((m) => {
      const phone = m.conversation?.customer?.phone || null;
      const country = countryOf(phone);
      const category = m.pricingCategory;

      if (m.status === "FAILED") totals.failed++;
      else if (m.status === "READ") totals.read++;
      else if (m.status === "DELIVERED") totals.delivered++;
      else if (m.status === "SENT") totals.sent++;
      else totals.pending++;
      if (m.errorCode === 131042) totals.paymentIssue = true;

      let cost = null;
      if (m.billable === true) {
        totals.billable++;
        const rate = rateFor(country, category);
        if (rate === null) totals.noRate++;
        else {
          cost = rate;
          totals.costUsd += rate;
        }
        const key = category || "unknown";
        totals.byCategory[key] = totals.byCategory[key] || { count: 0, costUsd: 0 };
        totals.byCategory[key].count++;
        totals.byCategory[key].costUsd += cost || 0;
      } else if (m.billable === false) {
        cost = 0;
        totals.free++;
      } else if (m.status !== "FAILED") {
        totals.awaitingPricing++;
      }

      return {
        id: m.id,
        createdAt: m.createdAt,
        to: phone,
        name: m.conversation?.customer?.name || null,
        country,
        line: m.conversation?.whatsappNumber?.label || null,
        conversationId: m.conversation?.id || null,
        messageType: m.messageType,
        preview: (m.content || "").slice(0, 80),
        status: m.status,
        billable: m.billable,
        pricingCategory: category,
        pricingType: m.pricingType,
        costUsd: cost,
        errorCode: m.errorCode,
        errorTitle: m.errorTitle,
        errorHint: m.errorCode ? ERROR_HINTS[m.errorCode] || null : null,
      };
    });

    totals.costUsd = Number(totals.costUsd.toFixed(4));
    // Totals cover the whole range; the list shows the latest 200.
    res.status(200).json({ success: true, data: { since, totals, messages: messages.slice(0, 200), rates: RATES_USD } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getBilling };
