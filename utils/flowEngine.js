// Runs Flows: the automation behind a campaign's template buttons.
//
// Lifecycle of one FlowRun:
//   1. START — a customer answers a campaign that has a flow (taps one of the
//      template's quick-reply buttons, or replies at all if the Start step's
//      "any reply" output is connected). The tap picks the Start output.
//   2. WALK — steps execute in order. Tag runs instantly; Message/List/Question
//      send to the customer. A step that asks something (buttons, a list, a
//      question) parks the run there: `currentNodeId` = that step.
//   3. RESUME — the customer's next tap or answer continues from the parked step.
//      Our own interactive messages carry button ids `f:<runId>:<nodeId>:<option>`,
//      so a tap is matched to its run and step exactly, never by its text.
//   4. END — an End step, an output with nothing connected, an Assign step
//      (HANDED_OFF), an agent replying by hand (HANDED_OFF), STOP (STOPPED),
//      or 24 hours without an answer (EXPIRED — the WhatsApp window is shut).
//
// Never allowed to break message intake: the webhook calls handleInbound after
// the customer's message is saved, and every failure here is logged and
// recorded on the run, not thrown.

const prisma = require("../config/prisma");
const numbers = require("./whatsappNumbers");
const { sendWhatsAppMessage, sendTypingIndicator } = require("./whatsappClient");
const { emitToNumber, emitToNumberStaff } = require("./socket");
const { isAssignable } = require("./conversationAssignment");
const logAudit = require("./audit");
const { nextNodeId, nodeById } = require("./flowGraph");
const { buildTemplateSend } = require("./templateSend");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

const RUN_TTL_MS = 24 * 60 * 60 * 1000;
// A walk that executes more steps than this without stopping for the customer
// is a mistake in the graph, not a conversation.
const MAX_STEPS_PER_WALK = 25;

// One inbound message at a time per conversation. Two taps landing together
// would otherwise both resume the same parked step. In-process only — the API
// runs as a single instance (same assumption as jobs/campaignScheduler.js).
const queues = new Map();
function serialize(conversationId, fn) {
  const prev = queues.get(conversationId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(conversationId, tail);
  tail.then(() => { if (queues.get(conversationId) === tail) queues.delete(conversationId); });
  return next;
}

const replyId = (runId, nodeId, optionId) => `f:${runId}:${nodeId}:${optionId}`;
function parseReplyId(id) {
  const m = /^f:(\d+):([^:]+):(.+)$/.exec(id || "");
  return m ? { runId: Number(m[1]), nodeId: m[2], optionId: m[3] } : null;
}

const emptyData = () => ({ answers: {}, path: [] });

// A card's name for the responses: its first line without WhatsApp
// formatting ("*Ulthera Skin Tightening*" → "Ulthera Skin Tightening").
function cardLabel(card) {
  const first = String(card.body || "").split("\n")[0].replace(/[*_~`]/g, "").trim();
  return first || card.id;
}
const dataOf = (run) => ({ ...emptyData(), ...(run.data || {}) });

// {{first_name}}, {{customer_name}}, {{phone}} and any collected answer.
function interpolate(text, customer, answers) {
  if (!text) return text;
  const vars = {
    first_name: customer?.name ? customer.name.split(" ")[0] : "there",
    customer_name: customer?.name || "there",
    name: customer?.name || "there",
    phone: customer?.phone || "",
    ...answers,
  };
  return text.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (full, key) => {
    const v = vars[key.toLowerCase()];
    if (v === undefined || v === null) return full;
    // A collected date is stored as 2026-10-15 (sortable, exportable) but
    // reads as "15 Oct 2026" in a message.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      return new Date(`${v}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    }
    return String(v);
  });
}

// Normalizes a free-text answer, or returns null when it doesn't fit the type.
function parseAnswer(inputType, raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  switch (inputType) {
    case "number": {
      const n = v.replace(/,/g, "");
      return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null;
    case "phone": {
      const p = parsePhoneNumberFromString(v, "AE");
      return p && p.isValid() ? p.number : null;
    }
    case "date": {
      // 25/12/2026, 25-12-2026, 2026-12-25. Day-first, as written in the UAE.
      let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
      let y, mo, d;
      if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
      else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else return null;
      const dt = new Date(Date.UTC(y, mo - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
      return dt.toISOString().slice(0, 10);
    }
    default:
      return v.slice(0, 1000);
  }
}

const DEFAULT_RETRY = {
  number: "Please reply with a number.",
  email: "That doesn't look like an email address — please try again.",
  phone: "Please send a valid phone number.",
  date: "Please send the date as DD/MM/YYYY.",
  text: "Please type your answer.",
};

/**
 * Send one automated message into the conversation and record it like any
 * other outbound message (senderType BOT). Returns the saved message, or throws
 * after recording the failure.
 */
// How long "typing…" shows before the flow's first reply to a tap/answer —
// long enough to be seen, short enough not to feel slow.
// (FLOW_TYPING_PAUSE_MS overrides it, e.g. 0 in tests.)
const TYPING_PAUSE_MS = Number(process.env.FLOW_TYPING_PAUSE_MS ?? 1200);

async function sendBot(ctx, { kind, text, mediaType, mediaUrl, footer, header, buttons, list, prebuilt, carousel }) {
  const { conversation, customer, numberId } = ctx;
  const credentials = await numbers.getCredentials(numberId);

  // Once per customer message, and only now that a reply is certain: show
  // "typing…" on it, then pause briefly. Never allowed to block the reply.
  if (ctx.typingFor && !ctx.typed) {
    ctx.typed = true;
    try {
      await sendTypingIndicator({ number: credentials, messageId: ctx.typingFor });
      await new Promise((r) => setTimeout(r, TYPING_PAUSE_MS));
    } catch (err) {
      console.warn("[flow] typing indicator failed (reply still sent):", err.response?.data?.error?.message || err.message);
    }
  }

  let messageType;
  let content;
  let sendArgs;
  if (prebuilt) {
    // An approved template (a carousel), built by buildTemplateSend.
    ({ messageType, content, sendArgs } = prebuilt);
  } else if (kind === "cards") {
    messageType = "INTERACTIVE";
    // Same shape as a carousel template's cards, so the inbox renders both.
    content = JSON.stringify({
      body: text,
      cards: carousel.map((c) => ({
        mediaType: c.mediaType, mediaUrl: c.mediaUrl, body: c.body || "",
        buttons: c.buttons.map((b) => ({ id: b.id, type: b.type, title: b.title, url: b.url })),
      })),
    });
    sendArgs = { content: text, messageType, carousel };
  } else if (kind === "list") {
    messageType = "INTERACTIVE";
    content = JSON.stringify({
      headerType: header ? "TEXT" : undefined, header, body: text, footer,
      list: { buttonLabel: list.buttonLabel, rows: list.rows.map(({ title, description }) => ({ title, description })) },
    });
    sendArgs = { content: text, messageType, headerType: header ? "TEXT" : null, header, footer, list };
  } else if (buttons && buttons.length) {
    messageType = "INTERACTIVE";
    const hasMedia = mediaType && mediaType !== "NONE";
    content = JSON.stringify({
      headerType: hasMedia ? mediaType : undefined,
      headerMediaUrl: hasMedia ? mediaUrl : undefined,
      body: text, footer,
      buttons: buttons.map((b) => ({ id: b.id, type: "QUICK_REPLY", title: b.title })),
    });
    sendArgs = {
      content: text, messageType, footer,
      headerType: hasMedia ? mediaType : null, headerMediaUrl: hasMedia ? mediaUrl : null,
      buttons: buttons.map((b) => ({ id: b.waId, type: "QUICK_REPLY", title: b.title })),
    };
  } else if (mediaType && mediaType !== "NONE") {
    messageType = mediaType;
    content = text || mediaUrl;
    sendArgs = { content: text || "", messageType, mediaUrl };
  } else {
    messageType = "TEXT";
    content = text;
    sendArgs = { content: text, messageType: "TEXT" };
  }

  let message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "BOT",
      senderId: null,
      content,
      messageType,
      mediaUrl: messageType === mediaType ? mediaUrl : null,
      status: "PENDING",
    },
  });

  let sendError = null;
  try {
    const { whatsappMessageId } = await sendWhatsAppMessage({ number: credentials, to: customer.phone, ...sendArgs });
    message = await prisma.message.update({ where: { id: message.id }, data: { whatsappMessageId, status: "SENT" } });
  } catch (err) {
    const meta = err.response?.data?.error;
    sendError = meta ? `${meta.code}: ${meta.message}` : err.message;
    message = await prisma.message.update({
      where: { id: message.id },
      data: { status: "FAILED", errorCode: Number(meta?.code) || null, errorTitle: (meta?.message || err.message).slice(0, 500) },
    });
  }

  const preview = prebuilt ? prebuilt.preview : kind === "list" || kind === "cards" || (buttons && buttons.length) ? text : content;
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessage: preview, lastMessageAt: new Date(), lastSenderType: "BOT" },
  });
  emitToNumber(numberId, "message.created", { message, conversationId: conversation.id });
  emitToNumber(numberId, "conversation.updated", { conversationId: conversation.id });

  if (sendError) throw new Error(`WhatsApp refused the message (${sendError})`);
  return message;
}

async function finish(run, status, extra = {}) {
  return prisma.flowRun.update({
    where: { id: run.id },
    data: { status, currentNodeId: null, completedAt: new Date(), ...extra },
  });
}

/**
 * Execute from `startNodeId` until the run parks on a step that waits for the
 * customer, or ends. `run` must be ACTIVE.
 */
async function walk(ctx, run, graph, startNodeId) {
  const data = dataOf(run);
  let nodeId = startNodeId;

  for (let step = 0; step < MAX_STEPS_PER_WALK; step++) {
    const node = nodeId ? nodeById(graph, nodeId) : null;
    if (!node) {
      return finish(run, "COMPLETED", { data });
    }
    const d = node.data || {};
    const say = (t) => interpolate(t, ctx.customer, data.answers);

    switch (node.type) {
      case "message": {
        const hasButtons = d.buttons && d.buttons.length > 0;
        await sendBot(ctx, {
          kind: "message",
          text: say(d.text),
          mediaType: d.mediaType,
          mediaUrl: d.mediaUrl,
          footer: d.footer,
          buttons: hasButtons ? d.buttons.map((b) => ({ ...b, waId: replyId(run.id, node.id, b.id) })) : null,
        });
        if (hasButtons) {
          return prisma.flowRun.update({ where: { id: run.id }, data: { currentNodeId: node.id, data } });
        }
        nodeId = nextNodeId(graph, node.id, "next");
        break;
      }
      case "list": {
        await sendBot(ctx, {
          kind: "list",
          text: say(d.text),
          header: d.header ? say(d.header) : undefined,
          footer: d.footer,
          list: {
            buttonLabel: d.buttonLabel,
            rows: d.rows.map((r) => ({ id: replyId(run.id, node.id, r.id), title: r.title, description: r.description })),
          },
        });
        return prisma.flowRun.update({ where: { id: run.id }, data: { currentNodeId: node.id, data } });
      }
      case "carousel": {
        const template = await prisma.template.findUnique({ where: { id: d.templateId } });
        const number = await numbers.getCredentials(ctx.numberId);
        if (!template || !template.isActive || !Array.isArray(template.cards) || !template.cards.length) {
          throw new Error("The carousel template for this step no longer exists");
        }
        if (template.approvalStatus !== "APPROVED") {
          throw new Error(`The carousel template "${template.name}" isn't approved by Meta yet`);
        }
        if (number.wabaId && template.wabaId !== number.wabaId) {
          throw new Error(`The carousel template "${template.name}" belongs to a different WhatsApp account than this chat`);
        }
        const built = buildTemplateSend(template, ctx.customer, null, {
          // Each card's quick reply reports this run + step + card back to us.
          cardPayload: (i, b) => replyId(run.id, node.id, `${i}.${b.id}`),
        });
        await sendBot(ctx, {
          prebuilt: { messageType: "TEMPLATE", content: built.templateContent, sendArgs: built.sendArgs, preview: built.resolvedBody },
        });
        const waits = (d.cards || []).some((c) => (c.buttons || []).length > 0);
        if (waits) {
          return prisma.flowRun.update({ where: { id: run.id }, data: { currentNodeId: node.id, data } });
        }
        nodeId = nextNodeId(graph, node.id, "next");
        break;
      }
      case "cards": {
        const carousel = (d.cards || []).map((c) => ({
          mediaType: c.mediaType,
          mediaUrl: c.mediaUrl,
          body: c.body ? say(c.body) : undefined,
          buttons: c.buttons.map((b) =>
            b.type === "URL" ? { type: "URL", title: b.title, url: b.url } : { type: "QUICK_REPLY", id: replyId(run.id, node.id, `${c.id}.${b.id}`), title: b.title },
          ),
        }));
        await sendBot(ctx, { kind: "cards", text: say(d.text), carousel });
        if ((d.cards || []).some((c) => c.buttons.some((b) => b.type !== "URL"))) {
          return prisma.flowRun.update({ where: { id: run.id }, data: { currentNodeId: node.id, data } });
        }
        nodeId = nextNodeId(graph, node.id, "next");
        break;
      }
      case "question": {
        await sendBot(ctx, { kind: "message", text: say(d.text) });
        return prisma.flowRun.update({ where: { id: run.id }, data: { currentNodeId: node.id, data } });
      }
      case "tag": {
        const tags = ctx.customer.tags || [];
        if (!tags.includes(d.tag)) {
          ctx.customer = await prisma.customer.update({
            where: { id: ctx.customer.id },
            data: { tags: { push: d.tag } },
          });
        }
        data.path.push({ node: node.id, tag: d.tag, at: new Date().toISOString() });
        nodeId = nextNodeId(graph, node.id, "next");
        break;
      }
      case "assign": {
        if (d.text) await sendBot(ctx, { kind: "message", text: say(d.text) });
        let agent = null;
        if (d.agentId) {
          const user = await prisma.user.findUnique({ where: { id: d.agentId } });
          agent = isAssignable(user) ? user : null;
        }
        await prisma.conversation.update({
          where: { id: ctx.conversation.id },
          data: { status: "OPEN", ...(agent ? { assignedAgentId: agent.id } : {}) },
        });
        if (agent) {
          emitToNumber(ctx.numberId, "conversation.assigned", {
            conversationId: ctx.conversation.id, agentId: agent.id, agentUsername: agent.username,
          });
        }
        emitToNumber(ctx.numberId, "conversation.updated", { conversationId: ctx.conversation.id });
        // Tell the team, wherever they are in the CRM, that a customer is
        // waiting for a person — with what they were looking at.
        const flowRow = await prisma.flow.findUnique({ where: { id: run.flowId }, select: { name: true } });
        emitToNumberStaff(ctx.numberId, "flow.handoff", {
          conversationId: ctx.conversation.id,
          customerName: ctx.customer.name || null,
          customerPhone: ctx.customer.phone,
          flowName: flowRow?.name || "Flow",
          interest: data.answers.offer || data.answers.category || null,
          agentId: agent?.id ?? null,
          agentUsername: agent?.username ?? null,
          at: new Date().toISOString(),
        });
        logAudit({
          action: "flow.handed_off",
          actor: null,
          targetType: "conversation",
          targetId: ctx.conversation.id,
          details: { flowRunId: run.id, flowId: run.flowId, agentId: agent?.id ?? null },
        });
        data.path.push({ node: node.id, handedOffTo: agent?.username ?? "team", at: new Date().toISOString() });
        return finish(run, "HANDED_OFF", { data });
      }
      case "end": {
        if (d.text) await sendBot(ctx, { kind: "message", text: say(d.text) });
        return finish(run, "COMPLETED", { data });
      }
      default:
        return finish(run, "FAILED", { data, lastError: `Unexpected step type ${node.type}` });
    }
  }
  return finish(run, "FAILED", { data, lastError: `Stopped after ${MAX_STEPS_PER_WALK} steps without waiting for the customer — check the flow for a loop` });
}

async function safeWalk(ctx, run, graph, startNodeId) {
  try {
    return await walk(ctx, run, graph, startNodeId);
  } catch (err) {
    console.error(`[flow] run ${run.id} failed:`, err.message);
    return finish(run, "FAILED", { lastError: err.message.slice(0, 500) }).catch(() => {});
  }
}

/** Stop every unfinished run in a conversation. */
async function endActiveRuns(conversationId, status) {
  return prisma.flowRun.updateMany({
    where: { conversationId, status: "ACTIVE" },
    data: { status, currentNodeId: null, completedAt: new Date() },
  });
}

/** An agent replied by hand: automation steps aside for the rest of this chat. */
async function handOffOnAgentReply(conversationId) {
  try {
    await endActiveRuns(conversationId, "HANDED_OFF");
  } catch (err) {
    console.error("[flow] hand-off on agent reply failed:", err.message);
  }
}

/** Runs parked longer than the WhatsApp window are dead — mark them so. */
async function expireStaleRuns(where = {}) {
  return prisma.flowRun.updateMany({
    where: { ...where, status: "ACTIVE", updatedAt: { lt: new Date(Date.now() - RUN_TTL_MS) } },
    data: { status: "EXPIRED", currentNodeId: null, completedAt: new Date() },
  });
}

// What a tap on (node, optionId) means: the choice's title, the output it
// leaves by, and what a "save as" variable stores. null = no such option any
// more (removed since the message went out).
function resolveTap(node, optionId) {
  const d = node.data || {};
  if (node.type === "cards") {
    // optionId is "<cardId>.<buttonId>"
    const dot = optionId.lastIndexOf(".");
    const card = (d.cards || []).find((c) => c.id === optionId.slice(0, dot));
    const button = card && card.buttons.find((b) => b.id === optionId.slice(dot + 1));
    if (!button) return null;
    const label = cardLabel(card);
    return { title: `${label} · ${button.title}`, handle: `card:${card.id}:${button.id}`, saveAs: label };
  }
  if (node.type === "carousel") {
    // optionId is "<cardIndex>.<buttonId>"
    const [cardIdx, buttonId] = optionId.split(".");
    const card = (d.cards || [])[Number(cardIdx)];
    const button = card && (card.buttons || []).find((b) => b.id === buttonId);
    if (!button) return null;
    const title = `${card.label} · ${button.title}`;
    return { title, handle: `card:${Number(cardIdx)}:${button.id}`, saveAs: title };
  }
  const isList = node.type === "list";
  const option = (isList ? d.rows : d.buttons || []).find((o) => o.id === optionId);
  if (!option) return null;
  return { title: option.title, handle: `${isList ? "row" : "btn"}:${option.id}`, saveAs: option.title };
}

async function hasOptedOut(ctx) {
  if (ctx.customer.optedOut) return true;
  const row = await prisma.customerOptOut.findFirst({
    where: { customerId: ctx.customer.id, whatsappNumberId: ctx.numberId },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * A forgiving flow: a tap on any button the flow ever sent in this chat works,
 * like an old link on a website.
 *   - From the run in progress, wherever it is now: jump to that branch. A
 *     question waiting for a typed answer is dropped — the customer changed
 *     their mind.
 *   - From a finished run (completed, expired, replaced): start a fresh run
 *     from that point, keeping the answers already given (e.g. which offer).
 *   - Never after a hand-off: once a person has the chat, the bot stays out
 *     (a new tap on the campaign message can still start over).
 *   - Never after STOP.
 */
async function resumeFromTap(ctx, tapped, active) {
  const source =
    active && active.id === tapped.runId
      ? active
      : await prisma.flowRun.findUnique({ where: { id: tapped.runId }, include: { flow: true } });
  if (!source || source.conversationId !== ctx.conversation.id) return; // not this chat's flow

  const latest = await prisma.flowRun.findFirst({
    where: { conversationId: ctx.conversation.id },
    orderBy: { startedAt: "desc" },
    select: { status: true },
  });
  if (latest?.status === "HANDED_OFF") return; // an agent has it
  if (await hasOptedOut(ctx)) return;

  const flow = source.flow;
  if (!flow || !flow.isActive) return;
  const graph = flow.graph;
  const node = nodeById(graph, tapped.nodeId);
  const choice = node && resolveTap(node, tapped.optionId);
  if (!choice) return; // that step or button was removed since — leave it to the agents

  let run = source;
  if (source.status !== "ACTIVE") {
    await endActiveRuns(ctx.conversation.id, "STOPPED"); // the new tap replaces whatever was running
    run = await prisma.flowRun.create({
      data: {
        flowId: flow.id,
        conversationId: ctx.conversation.id,
        customerId: ctx.customer.id,
        campaignId: source.campaignId,
        data: { answers: { ...dataOf(source).answers }, path: [] },
      },
    });
  }

  const data = dataOf(run);
  if (node.data.variable) data.answers[node.data.variable] = choice.saveAs;
  data.path.push({
    node: node.id,
    choice: choice.title,
    ...(run.id !== source.id || node.id !== source.currentNodeId ? { from: "earlier message" } : {}),
    at: new Date().toISOString(),
  });
  run = await prisma.flowRun.update({ where: { id: run.id }, data: { data } });
  return safeWalk(ctx, run, graph, nextNodeId(graph, node.id, choice.handle));
}

/**
 * Called by the webhook for every saved inbound customer message.
 *
 * @param inbound { rawType, content, buttonPayload, replyId }
 * @param campaignReply  attributeReply()'s result, or null
 * @param optIntent      "OUT" | "IN" | null
 */
function handleInbound({ numberId, customer, conversation, inbound, campaignReply, optIntent }) {
  return serialize(conversation.id, async () => {
    // typingFor: the customer's message the first reply will show "typing…" on.
    const ctx = { numberId, customer, conversation, typingFor: inbound.whatsappMessageId || null };

    if (optIntent === "OUT") {
      await endActiveRuns(conversation.id, "STOPPED");
      return;
    }

    await expireStaleRuns({ conversationId: conversation.id });
    const active = await prisma.flowRun.findFirst({
      where: { conversationId: conversation.id, status: "ACTIVE" },
      include: { flow: true },
      orderBy: { startedAt: "desc" },
    });

    // 1. A tap on one of OUR buttons — on ANY message the flow sent, not only
    // the latest: people scroll up and tap an old menu or card. See resumeFromTap.
    const tapped = parseReplyId(inbound.replyId);
    if (tapped) return resumeFromTap(ctx, tapped, active);

    // 2. A fresh answer to a campaign that has a flow: (re)start. While a run is
    // in progress only a new template-button tap restarts it — a typed message
    // that happens to quote the campaign is more likely an answer to the
    // current step than a request to start over.
    const mayStart = campaignReply && (!active || inbound.rawType === "button");
    const startMatch = mayStart ? await matchCampaignStart(campaignReply.campaign.id, inbound) : null;
    if (startMatch) {
      await endActiveRuns(conversation.id, "STOPPED"); // a new tap on the campaign replaces any older run
      const data = emptyData();
      data.path.push({ node: startMatch.triggerId, choice: startMatch.label, at: new Date().toISOString() });
      const run = await prisma.flowRun.create({
        data: {
          flowId: startMatch.flow.id,
          conversationId: conversation.id,
          customerId: customer.id,
          campaignId: campaignReply.campaign.id,
          data,
        },
      });
      return safeWalk(ctx, run, startMatch.flow.graph, startMatch.nextNodeId);
    }

    // 3. A typed answer to a parked Question step.
    if (active && active.currentNodeId) {
      const graph = active.flow.graph;
      const node = nodeById(graph, active.currentNodeId);
      if (node?.type !== "question" || inbound.rawType !== "text") return; // not an answer — the agents see it in the inbox
      const value = parseAnswer(node.data.inputType, inbound.content);
      if (value === null) {
        try {
          await sendBot(ctx, { kind: "message", text: node.data.errorText || DEFAULT_RETRY[node.data.inputType] || DEFAULT_RETRY.text });
          await prisma.flowRun.update({ where: { id: active.id }, data: { updatedAt: new Date() } });
        } catch (err) {
          await finish(active, "FAILED", { lastError: err.message.slice(0, 500) });
        }
        return;
      }
      const data = dataOf(active);
      data.answers[node.data.variable] = value;
      data.path.push({ node: node.id, answer: value, at: new Date().toISOString() });
      const run = await prisma.flowRun.update({ where: { id: active.id }, data: { data } });
      return safeWalk(ctx, run, graph, nextNodeId(graph, node.id, "next"));
    }
  }).catch((err) => {
    console.error("[flow] inbound handling failed (message kept):", err.message);
  });
}

// Which Start output a campaign answer takes, if the campaign has a live flow.
async function matchCampaignStart(campaignId, inbound) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { flow: true },
  });
  const flow = campaign?.flow;
  if (!flow || !flow.isActive) return null;
  const trigger = (flow.graph.nodes || []).find((n) => n.type === "trigger");
  if (!trigger) return null;

  // A template quick-reply tap arrives as type "button". Its payload is the
  // button text unless the send set one, so match on both, case-insensitively.
  // A carousel campaign's card tap carries "cb:<card>:<button>" (see
  // templateSend.js). The Start step names those buttons c<card>_<button>.
  const cardTap = /^cb:(\d+):(.+)$/.exec(inbound.buttonPayload || "");
  if (inbound.rawType === "button" && cardTap) {
    const button = (trigger.data.buttons || []).find((b) => b.id === `c${cardTap[1]}_${cardTap[2]}`);
    const target = button && nextNodeId(flow.graph, trigger.id, `btn:${button.id}`);
    if (target) return { flow, triggerId: trigger.id, label: button.title, nextNodeId: target };
  }
  if (inbound.rawType === "button") {
    const said = [inbound.buttonPayload, inbound.content].filter(Boolean).map((s) => s.trim().toLowerCase());
    const button = (trigger.data.buttons || []).find((b) => said.includes(b.title.trim().toLowerCase()));
    const target = button && nextNodeId(flow.graph, trigger.id, `btn:${button.id}`);
    if (target) return { flow, triggerId: trigger.id, label: button.title, nextNodeId: target };
  }
  const anyTarget = nextNodeId(flow.graph, trigger.id, "any");
  if (anyTarget) return { flow, triggerId: trigger.id, label: "Any reply", nextNodeId: anyTarget };
  return null;
}

module.exports = { handleInbound, handOffOnAgentReply, expireStaleRuns, parseAnswer, interpolate };
