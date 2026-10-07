const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { validateGraph, variablesOf } = require("../../utils/flowGraph");
const { expireStaleRuns } = require("../../utils/flowEngine");

const RUN_STATUSES = ["ACTIVE", "COMPLETED", "HANDED_OFF", "STOPPED", "EXPIRED", "FAILED"];

const parseId = (raw) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// 400 that carries the per-step problems in `details.errors` (where the
// frontend's ApiError looks), so the builder can mark each step.
const invalidGraph = (res, errors) =>
  res.status(400).json({
    success: false,
    code: "INVALID_FLOW",
    message: errors[0]?.message || "The flow has problems",
    details: { errors },
  });

// Run counts per status for a set of flows: { [flowId]: { total, ACTIVE, ... } }.
async function runStats(flowIds) {
  if (!flowIds.length) return {};
  const rows = await prisma.flowRun.groupBy({
    by: ["flowId", "status"],
    where: { flowId: { in: flowIds } },
    _count: { _all: true },
  });
  const out = {};
  for (const r of rows) {
    const s = (out[r.flowId] ||= { total: 0 });
    s[r.status] = r._count._all;
    s.total += r._count._all;
  }
  return out;
}

// ─── GET /api/campaigns/flows ────────────────────────────────────────────────
const listFlows = async (req, res, next) => {
  try {
    const flows = await prisma.flow.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, description: true, isActive: true, createdAt: true, updatedAt: true,
        createdBy: { select: { id: true, name: true, username: true } },
        _count: { select: { campaigns: true } },
      },
    });
    const stats = await runStats(flows.map((f) => f.id));
    res.json({
      success: true,
      data: flows.map(({ _count, ...f }) => ({ ...f, campaignCount: _count.campaigns, runs: stats[f.id] || { total: 0 } })),
    });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/campaigns/flows/:id ────────────────────────────────────────────
const getFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const flow = await prisma.flow.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, username: true } },
        campaigns: { select: { id: true, name: true, status: true }, orderBy: { createdAt: "desc" } },
      },
    });
    if (!flow) return next(new AppError("Flow not found", 404));
    const stats = await runStats([id]);
    res.json({ success: true, data: { ...flow, variables: variablesOf(flow.graph), runs: stats[id] || { total: 0 } } });
  } catch (err) {
    next(err);
  }
};

// ─── POST /api/campaigns/flows ───────────────────────────────────────────────
const createFlow = async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return next(new AppError("Give the flow a name", 400));
    const { graph, errors } = validateGraph(req.body.graph);
    if (errors.length) return invalidGraph(res, errors);

    const flow = await prisma.flow.create({
      data: {
        name: name.slice(0, 120),
        description: String(req.body.description || "").trim().slice(0, 500) || null,
        isActive: req.body.isActive !== false,
        graph,
        createdById: req.user.id,
      },
    });
    logAudit({ action: "flow.created", actor: req.user, targetType: "flow", targetId: flow.id, details: { name: flow.name } });
    res.status(201).json({ success: true, data: { ...flow, variables: variablesOf(graph) } });
  } catch (err) {
    next(err);
  }
};

// ─── PUT /api/campaigns/flows/:id ────────────────────────────────────────────
// Editing a flow affects runs already in progress: a parked run resumes into
// the NEW graph. A step that was deleted ends that run (recorded as FAILED with
// the reason), which is the honest outcome — the step it was waiting on is gone.
const updateFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const existing = await prisma.flow.findUnique({ where: { id }, select: { id: true, updatedAt: true } });
    if (!existing) return next(new AppError("Flow not found", 404));

    // A builder tab opened before someone else saved must not silently put
    // its older copy back: the editor sends the version it loaded, and a save
    // based on an outdated version is refused.
    if (req.body.graph !== undefined && req.body.baseUpdatedAt) {
      const base = new Date(req.body.baseUpdatedAt);
      if (!Number.isNaN(base.getTime()) && existing.updatedAt.getTime() > base.getTime()) {
        return next(new AppError(
          "This flow was changed somewhere else after you opened it. Reload the page to get the latest version before saving.",
          409,
          "FLOW_CHANGED",
        ));
      }
    }

    const data = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return next(new AppError("Give the flow a name", 400));
      data.name = name.slice(0, 120);
    }
    if (req.body.description !== undefined) data.description = String(req.body.description || "").trim().slice(0, 500) || null;
    if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
    if (req.body.graph !== undefined) {
      const { graph, errors } = validateGraph(req.body.graph);
      if (errors.length) return invalidGraph(res, errors);
      data.graph = graph;
    }

    const flow = await prisma.flow.update({ where: { id }, data });
    logAudit({
      action: "flow.updated", actor: req.user, targetType: "flow", targetId: id,
      details: { fields: Object.keys(data), ...(data.isActive !== undefined ? { isActive: data.isActive } : {}) },
    });
    res.json({ success: true, data: { ...flow, variables: variablesOf(flow.graph) } });
  } catch (err) {
    next(err);
  }
};

// ─── DELETE /api/campaigns/flows/:id ─────────────────────────────────────────
// Deleting would delete every response the flow collected (FlowRun cascades),
// so a flow that has been used can only be turned off.
const deleteFlow = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const flow = await prisma.flow.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { runs: true } } } });
    if (!flow) return next(new AppError("Flow not found", 404));
    if (flow._count.runs > 0) {
      return next(new AppError(
        `This flow has ${flow._count.runs} response(s). Turn it off instead, so its collected data is kept.`, 409,
      ));
    }
    await prisma.flow.delete({ where: { id } });
    logAudit({ action: "flow.deleted", actor: req.user, targetType: "flow", targetId: id, details: { name: flow.name } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ─── GET /api/campaigns/flows/:id/runs?status=&page=&limit= ──────────────────
// The flow's responses: who went through it, where they ended, what they gave.
const listFlowRuns = async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return next(new AppError("Invalid flow id", 400));
    const flow = await prisma.flow.findUnique({ where: { id }, select: { id: true, graph: true } });
    if (!flow) return next(new AppError("Flow not found", 404));

    await expireStaleRuns({ flowId: id });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
    const where = { flowId: id };
    if (req.query.status) {
      if (!RUN_STATUSES.includes(req.query.status)) return next(new AppError("Unknown status", 400));
      where.status = req.query.status;
    }
    // Number scoping: a run lives in a conversation on one line; only show the
    // runs of the line being viewed, like every other inbox-derived list.
    if (req.numberId) where.conversation = { whatsappNumberId: req.numberId };

    const [runs, total] = await Promise.all([
      prisma.flowRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          campaign: { select: { id: true, name: true } },
        },
      }),
      prisma.flowRun.count({ where }),
    ]);
    res.json({
      success: true,
      data: runs,
      variables: variablesOf(flow.graph),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { listFlows, getFlow, createFlow, updateFlow, deleteFlow, listFlowRuns };
