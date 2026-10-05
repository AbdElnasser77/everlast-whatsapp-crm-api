const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const {
  buildCustomerWhere,
  validateDefinition,
  resolveMemberIds,
  describeFields,
  normalizeDefinition,
} = require("../../utils/segmentFilter");

// A preview samples this many matching contacts so the builder can show who it
// caught, not just how many. Small on purpose — the count is the answer, the
// sample is only a sanity check that the rule means what the user thought.
const PREVIEW_SAMPLE = 12;

const PREVIEW_SELECT = {
  id: true,
  name: true,
  phone: true,
  gender: true,
  nationality: true,
  departments: true,
  tags: true,
  joinDate: true,
  optedOut: true,
};

// Counting a segment is the operation that gets called on every keystroke in
// the builder, so it stays a COUNT — never a findMany the caller then measures.
async function countMatching(definition, excludeOptedOut) {
  const where = await buildCustomerWhere(definition, { excludeOptedOut });
  return prisma.customer.count({ where });
}

// ── Rule grammar & vocabulary ───────────────────────────────────────────────

// The UI builds its field and operator menus from here rather than hardcoding
// the grammar, so adding a filter server-side is enough to expose it.
const getFilterFields = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: describeFields() });
  } catch (err) {
    next(err);
  }
};

// The real distinct values behind the free-text columns. Without this the user
// types "Dermatology" and silently matches nothing because the import wrote
// "DERMATOLOGY" — picking from the actual data is what stops a segment from
// quietly targeting zero people.
const getFilterOptions = async (req, res, next) => {
  try {
    const [rows, nationalities, lists] = await Promise.all([
      prisma.customer.findMany({ select: { departments: true, tags: true } }),
      prisma.customer.findMany({
        where: { nationality: { not: null } },
        select: { nationality: true },
        distinct: ["nationality"],
        orderBy: { nationality: "asc" },
      }),
      prisma.contactList.findMany({
        select: { id: true, name: true, _count: { select: { members: true } } },
        orderBy: { name: "asc" },
      }),
    ]);

    const departments = new Set();
    const tags = new Set();
    for (const r of rows) {
      r.departments.forEach((d) => d && departments.add(d));
      r.tags.forEach((t) => t && tags.add(t));
    }

    res.status(200).json({
      success: true,
      data: {
        departments: [...departments].sort((a, b) => a.localeCompare(b)),
        tags: [...tags].sort((a, b) => a.localeCompare(b)),
        nationalities: nationalities.map((n) => n.nationality).filter(Boolean),
        lists: lists.map((l) => ({ id: l.id, name: l.name, memberCount: l._count.members })),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Live preview ────────────────────────────────────────────────────────────

// Ad-hoc: takes a definition that has never been saved. This is what turns the
// builder from "guess and send" into "see the audience, then send" — the
// count is computed by the same compiler the send path uses, so what is shown
// here is what will actually be messaged.
const previewSegment = async (req, res, next) => {
  try {
    const { definition, excludeOptedOut = true } = req.body;
    validateDefinition(definition);

    const exclude = excludeOptedOut !== false;

    // Total (rules only) vs reachable (rules + consent) — showing both makes
    // the cost of opt-outs visible instead of silently shrinking the audience.
    const [matched, reachable, sample] = await Promise.all([
      countMatching(definition, false),
      countMatching(definition, exclude),
      buildCustomerWhere(definition, { excludeOptedOut: exclude }).then((where) =>
        prisma.customer.findMany({
          where,
          select: PREVIEW_SELECT,
          orderBy: { id: "desc" },
          take: PREVIEW_SAMPLE,
        }),
      ),
    ]);

    res.status(200).json({
      success: true,
      data: {
        matched,
        reachable,
        suppressed: matched - reachable,
        excludeOptedOut: exclude,
        sample,
        ruleCount: normalizeDefinition(definition).rules.length,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── CRUD ────────────────────────────────────────────────────────────────────

const getAllSegments = async (req, res, next) => {
  try {
    const segments = await prisma.segment.findMany({
      include: {
        createdBy: { select: { id: true, name: true, username: true } },
        _count: { select: { campaigns: true } },
      },
      orderBy: { updatedAt: "desc" },
    });

    // Counts are live by definition, so they are computed per request rather
    // than cached on the row — a cached count is the exact lie this model
    // exists to avoid. A segment whose rules no longer compile (a list it
    // referenced was deleted, say) reports null instead of failing the whole
    // page, and the UI flags it for repair.
    const withCounts = await Promise.all(
      segments.map(async (s) => {
        let reachable = null;
        let error = null;
        try {
          reachable = await countMatching(s.definition, s.excludeOptedOut);
        } catch (err) {
          error = err.message;
        }
        return {
          ...s,
          campaignCount: s._count.campaigns,
          _count: undefined,
          reachable,
          error,
        };
      }),
    );

    res.status(200).json({ success: true, data: withCounts });
  } catch (err) {
    next(err);
  }
};

const getSegmentById = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const segment = await prisma.segment.findUnique({
      where: { id },
      include: { createdBy: { select: { id: true, name: true, username: true } } },
    });
    if (!segment) return next(new AppError("Segment not found", 404));

    const [matched, reachable, sample] = await Promise.all([
      countMatching(segment.definition, false),
      countMatching(segment.definition, segment.excludeOptedOut),
      buildCustomerWhere(segment.definition, { excludeOptedOut: segment.excludeOptedOut }).then((where) =>
        prisma.customer.findMany({ where, select: PREVIEW_SELECT, orderBy: { id: "desc" }, take: PREVIEW_SAMPLE }),
      ),
    ]);

    res.status(200).json({
      success: true,
      data: { ...segment, matched, reachable, suppressed: matched - reachable, sample },
    });
  } catch (err) {
    next(err);
  }
};

const createSegment = async (req, res, next) => {
  try {
    const { name, description, definition, excludeOptedOut } = req.body;
    if (!name || !name.trim()) return next(new AppError("name is required", 400));

    // Reject a broken rule here rather than at send time.
    validateDefinition(definition);

    const { rules } = normalizeDefinition(definition);
    if (rules.length === 0) {
      return next(new AppError("A segment needs at least one rule — an empty rule set matches every contact", 400));
    }

    const segment = await prisma.segment.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        definition: normalizeDefinition(definition),
        excludeOptedOut: excludeOptedOut !== false,
        createdById: req.user.id,
      },
      include: { createdBy: { select: { id: true, name: true, username: true } } },
    });

    logAudit({
      action: "SEGMENT_CREATED",
      actor: req.user,
      targetType: "Segment",
      targetId: segment.id,
      details: { name: segment.name, ruleCount: rules.length, excludeOptedOut: segment.excludeOptedOut },
    });

    const reachable = await countMatching(segment.definition, segment.excludeOptedOut);
    res.status(201).json({ success: true, data: { ...segment, reachable } });
  } catch (err) {
    next(err);
  }
};

const updateSegment = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { name, description, definition, excludeOptedOut } = req.body;

    const existing = await prisma.segment.findUnique({ where: { id } });
    if (!existing) return next(new AppError("Segment not found", 404));

    const data = {};
    if (name !== undefined) {
      if (!name.trim()) return next(new AppError("name cannot be empty", 400));
      data.name = name.trim();
    }
    if (description !== undefined) data.description = description?.trim() || null;
    if (excludeOptedOut !== undefined) data.excludeOptedOut = excludeOptedOut !== false;
    if (definition !== undefined) {
      validateDefinition(definition);
      const { rules } = normalizeDefinition(definition);
      if (rules.length === 0) {
        return next(new AppError("A segment needs at least one rule", 400));
      }
      data.definition = normalizeDefinition(definition);
    }

    const segment = await prisma.segment.update({
      where: { id },
      data,
      include: { createdBy: { select: { id: true, name: true, username: true } } },
    });

    logAudit({
      action: "SEGMENT_UPDATED",
      actor: req.user,
      targetType: "Segment",
      targetId: segment.id,
      details: { name: segment.name, changed: Object.keys(data) },
    });

    const reachable = await countMatching(segment.definition, segment.excludeOptedOut);
    res.status(200).json({ success: true, data: { ...segment, reachable } });
  } catch (err) {
    next(err);
  }
};

const deleteSegment = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const segment = await prisma.segment.findUnique({
      where: { id },
      include: { _count: { select: { campaigns: true } } },
    });
    if (!segment) return next(new AppError("Segment not found", 404));

    // Campaigns keep their frozen recipients and their audienceSnapshot, so
    // deleting the rule loses the provenance link but never the record of who
    // was actually messaged (schema uses onDelete: SetNull).
    await prisma.segment.delete({ where: { id } });

    logAudit({
      action: "SEGMENT_DELETED",
      actor: req.user,
      targetType: "Segment",
      targetId: id,
      details: { name: segment.name, campaignsAffected: segment._count.campaigns },
    });

    res.status(200).json({ success: true, message: "Segment deleted" });
  } catch (err) {
    next(err);
  }
};

// ── Resolution ──────────────────────────────────────────────────────────────

// The ids a segment currently resolves to. Consent exclusion is forced on here
// regardless of the segment's own setting — anything reaching for a recipient
// list is on a send path, and an opted-out contact never belongs on one.
const getSegmentMemberIds = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) return next(new AppError("Segment not found", 404));

    const customerIds = await resolveMemberIds(segment.definition, { excludeOptedOut: true });

    res.status(200).json({
      success: true,
      data: { id: segment.id, name: segment.name, customerIds, count: customerIds.length },
    });
  } catch (err) {
    next(err);
  }
};

// Paginated members, for browsing a segment the way a list is browsed.
const getSegmentMembers = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));

    const segment = await prisma.segment.findUnique({ where: { id } });
    if (!segment) return next(new AppError("Segment not found", 404));

    const where = await buildCustomerWhere(segment.definition, {
      excludeOptedOut: segment.excludeOptedOut,
      search: req.query.search,
    });

    const [members, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.customer.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: { segment: { id: segment.id, name: segment.name }, members },
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getFilterFields,
  getFilterOptions,
  previewSegment,
  getAllSegments,
  getSegmentById,
  createSegment,
  updateSegment,
  deleteSegment,
  getSegmentMemberIds,
  getSegmentMembers,
  countMatching,
};
