// The shape of a saved Flow graph, and the one validator both the save endpoint
// and the engine trust.
//
// graph = { nodes: [{ id, type, position: { x, y }, data }], edges: [{ id, source, sourceHandle, target }] }
//
// A node's outputs are "handles". An edge leaves a node from one handle:
//   trigger   btn:<buttonId> per template quick-reply button, plus `any` (any other reply)
//   message   btn:<buttonId> per button, or `next` when it has no buttons
//   list      row:<rowId> per row
//   carousel  card:<cardIndex>:<buttonId> per card quick reply, or `next` when
//             the cards only have link buttons
//   question  next          (after a valid answer)
//   tag       next
//   assign    —             (hands the chat to a human; the run ends)
//   end       —
// A handle with no edge simply ends the run there.
//
// The limits are WhatsApp's own: past them Meta rejects the message at send
// time, which in a flow means a customer left hanging mid-conversation — so they
// are enforced here, at save, instead.

const NODE_TYPES = ["trigger", "message", "list", "carousel", "question", "tag", "assign", "end"];
const MEDIA_TYPES = ["NONE", "IMAGE", "VIDEO", "DOCUMENT"];
const INPUT_TYPES = ["text", "number", "email", "phone", "date"];

const LIMITS = {
  body: 1024, // interactive message body
  text: 4096, // plain text message
  buttonTitle: 20,
  buttons: 3,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  listButtonLabel: 20,
  header: 60,
  footer: 60,
  nodes: 100,
};

const VARIABLE_RE = /^[a-z_][a-z0-9_]{0,39}$/;

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Handles a node exposes, in display order. */
function handlesOf(node) {
  const d = node.data || {};
  switch (node.type) {
    case "trigger":
      return [...(d.buttons || []).map((b) => `btn:${b.id}`), "any"];
    case "message":
      return d.buttons && d.buttons.length ? d.buttons.map((b) => `btn:${b.id}`) : ["next"];
    case "list":
      return (d.rows || []).map((r) => `row:${r.id}`);
    case "carousel": {
      const taps = (d.cards || []).flatMap((c, i) => (c.buttons || []).map((b) => `card:${i}:${b.id}`));
      return taps.length ? taps : ["next"];
    }
    case "question":
    case "tag":
      return ["next"];
    default:
      return [];
  }
}

/** The node an edge from (nodeId, handle) leads to, or null. */
function nextNodeId(graph, nodeId, handle) {
  const edge = (graph.edges || []).find((e) => e.source === nodeId && (e.sourceHandle || "next") === handle);
  return edge ? edge.target : null;
}

function nodeById(graph, id) {
  return (graph.nodes || []).find((n) => n.id === id) || null;
}

/** Variables the flow can collect — the columns of its responses table. */
function variablesOf(graph) {
  const out = [];
  for (const n of graph.nodes || []) {
    const v = str(n.data?.variable);
    if (v && ["question", "message", "list", "carousel"].includes(n.type) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Validate a graph. Returns { graph, errors } where `graph` is the normalized
 * copy to store and `errors` is a list of { nodeId?, message } — empty when valid.
 */
function validateGraph(input) {
  const errors = [];
  const fail = (message, nodeId) => errors.push(nodeId ? { nodeId, message } : { message });

  if (!input || typeof input !== "object" || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    return { graph: null, errors: [{ message: "Graph must be { nodes: [], edges: [] }" }] };
  }
  if (input.nodes.length > LIMITS.nodes) fail(`A flow can have at most ${LIMITS.nodes} steps`);

  const ids = new Set();
  const nodes = [];
  for (const raw of input.nodes) {
    const id = str(raw?.id);
    const type = raw?.type;
    if (!id) { fail("A step is missing its id"); continue; }
    if (ids.has(id)) { fail(`Two steps share the id "${id}"`, id); continue; }
    if (!NODE_TYPES.includes(type)) { fail(`Unknown step type "${type}"`, id); continue; }
    ids.add(id);

    const d = raw.data || {};
    const data = {};

    const checkText = (field, max, required = true) => {
      const v = str(d[field]);
      if (required && !v) fail("Message text is required", id);
      if (v.length > max) fail(`Text is ${v.length} characters — WhatsApp allows ${max}`, id);
      return v;
    };
    const checkOptions = (list, kind) => {
      const seen = new Set();
      return (Array.isArray(list) ? list : []).map((o) => {
        const oid = str(o?.id);
        const title = str(o?.title);
        if (!oid || seen.has(oid)) fail(`Each ${kind} needs a unique id`, id);
        seen.add(oid);
        if (!title) fail(`Every ${kind} needs a title`, id);
        return { id: oid, title };
      });
    };
    const checkVariable = () => {
      const v = str(d.variable);
      if (v && !VARIABLE_RE.test(v)) {
        fail(`"${v}" isn't a valid field name — use lowercase letters, numbers and _ (e.g. booking_date)`, id);
      }
      return v || undefined;
    };

    switch (type) {
      case "trigger": {
        data.templateId = Number.isInteger(d.templateId) ? d.templateId : null;
        data.buttons = checkOptions(d.buttons, "button");
        break;
      }
      case "message": {
        data.mediaType = MEDIA_TYPES.includes(d.mediaType) ? d.mediaType : "NONE";
        data.mediaUrl = str(d.mediaUrl) || undefined;
        if (data.mediaType !== "NONE" && !/^https:\/\//i.test(data.mediaUrl || "")) {
          fail("Media needs a public https:// link", id);
        }
        data.buttons = checkOptions(d.buttons, "button");
        if (data.buttons.length > LIMITS.buttons) fail(`WhatsApp allows at most ${LIMITS.buttons} buttons`, id);
        for (const b of data.buttons) {
          if (b.title.length > LIMITS.buttonTitle) fail(`Button "${b.title}" is longer than ${LIMITS.buttonTitle} characters`, id);
        }
        data.text = checkText("text", data.buttons.length ? LIMITS.body : LIMITS.text, data.mediaType === "NONE");
        data.footer = str(d.footer) || undefined;
        if (data.footer && !data.buttons.length) data.footer = undefined; // footers only exist on interactive messages
        if ((data.footer || "").length > LIMITS.footer) fail(`Footer is longer than ${LIMITS.footer} characters`, id);
        data.variable = data.buttons.length ? checkVariable() : undefined;
        break;
      }
      case "list": {
        data.text = checkText("text", LIMITS.body);
        data.header = str(d.header) || undefined;
        if ((data.header || "").length > LIMITS.header) fail(`Header is longer than ${LIMITS.header} characters`, id);
        data.footer = str(d.footer) || undefined;
        if ((data.footer || "").length > LIMITS.footer) fail(`Footer is longer than ${LIMITS.footer} characters`, id);
        data.buttonLabel = str(d.buttonLabel);
        if (!data.buttonLabel) fail("The list needs a button label (e.g. \"View options\")", id);
        if (data.buttonLabel.length > LIMITS.listButtonLabel) fail(`Button label is longer than ${LIMITS.listButtonLabel} characters`, id);
        const rawRows = Array.isArray(d.rows) ? d.rows : [];
        data.rows = checkOptions(rawRows, "option").map((r, i) => {
          const description = str(rawRows[i]?.description) || undefined;
          if (r.title.length > LIMITS.rowTitle) fail(`Option "${r.title}" is longer than ${LIMITS.rowTitle} characters`, id);
          if ((description || "").length > LIMITS.rowDescription) fail(`An option description is longer than ${LIMITS.rowDescription} characters`, id);
          return { ...r, description };
        });
        if (!data.rows.length) fail("A list needs at least one option", id);
        if (data.rows.length > LIMITS.listRows) fail(`WhatsApp lists allow at most ${LIMITS.listRows} options`, id);
        data.variable = checkVariable();
        break;
      }
      case "carousel": {
        // A snapshot of the chosen carousel template's cards (label + quick
        // replies), taken in the builder. The template itself is loaded at
        // send time — it must be APPROVED on the conversation's account.
        data.templateId = Number.isInteger(d.templateId) ? d.templateId : null;
        if (!data.templateId) fail("Choose an approved carousel template", id);
        data.cards = (Array.isArray(d.cards) ? d.cards : []).map((c) => ({
          label: str(c?.label) || "Card",
          buttons: (Array.isArray(c?.buttons) ? c.buttons : []).map((b) => ({ id: str(b?.id), title: str(b?.title) })).filter((b) => b.id),
        }));
        data.variable = checkVariable();
        break;
      }
      case "question": {
        data.text = checkText("text", LIMITS.text);
        data.inputType = INPUT_TYPES.includes(d.inputType) ? d.inputType : "text";
        data.variable = checkVariable();
        if (!data.variable) fail("Choose a field name to save the answer in (e.g. preferred_date)", id);
        data.errorText = str(d.errorText) || undefined;
        break;
      }
      case "tag": {
        data.tag = str(d.tag);
        if (!data.tag) fail("Enter the tag to add", id);
        if (data.tag.length > 50) fail("Tag is longer than 50 characters", id);
        break;
      }
      case "assign": {
        data.agentId = Number.isInteger(d.agentId) ? d.agentId : null;
        data.text = str(d.text) || undefined;
        break;
      }
      case "end": {
        data.text = str(d.text) || undefined;
        break;
      }
    }

    const x = Number(raw.position?.x);
    const y = Number(raw.position?.y);
    nodes.push({ id, type, position: { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }, data });
  }

  const triggers = nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) fail("A flow needs exactly one Start step");

  const handleSets = new Map(nodes.map((n) => [n.id, new Set(handlesOf(n))]));
  const edges = [];
  const usedHandles = new Set();
  for (const raw of input.edges) {
    const source = str(raw?.source);
    const target = str(raw?.target);
    const sourceHandle = str(raw?.sourceHandle) || "next";
    // An edge to or from a deleted step, or from a deleted button, is stale
    // editor state, not a user mistake: drop it rather than refuse the save.
    if (!handleSets.has(source) || !handleSets.has(target)) continue;
    if (!handleSets.get(source).has(sourceHandle)) continue;
    if (source === target) { fail("A step can't lead to itself", source); continue; }
    const key = `${source}|${sourceHandle}`;
    if (usedHandles.has(key)) { fail("One output is connected to two steps — pick one", source); continue; }
    usedHandles.add(key);
    if (nodeById({ nodes }, target)?.type === "trigger") { fail("Nothing can lead back into the Start step", source); continue; }
    edges.push({ id: str(raw.id) || `e-${source}-${sourceHandle}-${target}`, source, sourceHandle, target });
  }

  if (triggers.length === 1 && !edges.some((e) => e.source === triggers[0].id)) {
    fail("Connect at least one Start output to a step", triggers[0].id);
  }

  return { graph: { nodes, edges }, errors };
}

module.exports = { NODE_TYPES, INPUT_TYPES, LIMITS, handlesOf, nextNodeId, nodeById, variablesOf, validateGraph };
