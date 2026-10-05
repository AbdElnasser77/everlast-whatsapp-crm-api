const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { buildCustomerWhere, validateDefinition } = require("../../utils/segmentFilter");
const {
  normalizeImportPhone,
  parseGender,
  parseDate,
  parseFlexibleDate,
  toStringArray,
  splitList,
  parseUpload,
} = require("./import.utils");

// Build a categorized import plan: validate + normalize each row, then split
// into rows to create vs. duplicates (against DB + within the file). Shared by
// the dry-run validate endpoint and the real import.
async function buildImportPlan(rows, dateFormat = "auto", defaultCountry = "") {
  const invalid = [];
  const duplicates = [];
  const candidates = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +2: row 1 is the header
    const { phone, error: phoneError } = normalizeImportPhone(row.phone, defaultCountry);
    if (phoneError) { invalid.push({ row: rowNum, phone: row.phone?.trim() || undefined, reason: phoneError }); continue; }
    const gender = parseGender(row.gender);
    if (gender === undefined) { invalid.push({ row: rowNum, phone, reason: "Invalid gender (use Male or Female)" }); continue; }
    const dateOfBirth = parseFlexibleDate(row.date_of_birth || row.dateofbirth || row.dob, dateFormat);
    if (dateOfBirth === undefined) { invalid.push({ row: rowNum, phone, reason: "Unrecognized date of birth" }); continue; }
    const joinDate = parseFlexibleDate(row.join_date || row.joindate, dateFormat);
    if (joinDate === undefined) { invalid.push({ row: rowNum, phone, reason: "Unrecognized join date" }); continue; }
    const email = row.email?.trim() || null;
    candidates.push({
      rowNum, phone, email,
      data: {
        name: row.name?.trim() || null,
        phone, email,
        chartNumber: (row.chart_number || row.chartnumber)?.trim() || null,
        nationality: row.nationality?.trim() || null,
        gender, dateOfBirth, joinDate,
        departments: splitList(row.departments),
        tags: splitList(row.tags),
        notes: row.notes?.trim() || null,
      },
    });
  }

  // Duplicates are determined by mobile (phone) and chart number only.
  const phones = [...new Set(candidates.map((c) => c.phone))];
  const charts = [...new Set(candidates.map((c) => c.data.chartNumber).filter(Boolean))];
  const existing = (phones.length || charts.length)
    ? await prisma.customer.findMany({
        where: { OR: [...(phones.length ? [{ phone: { in: phones } }] : []), ...(charts.length ? [{ chartNumber: { in: charts } }] : [])] },
        select: { phone: true, chartNumber: true },
      })
    : [];
  const existingPhones = new Set(existing.map((e) => e.phone));
  const existingCharts = new Set(existing.map((e) => e.chartNumber).filter(Boolean));

  const seenPhones = new Set();
  const seenCharts = new Set();
  const toCreate = [];
  for (const c of candidates) {
    const chart = c.data.chartNumber;
    if (existingPhones.has(c.phone)) { duplicates.push({ row: c.rowNum, phone: c.phone, reason: "Mobile already exists" }); continue; }
    if (chart && existingCharts.has(chart)) { duplicates.push({ row: c.rowNum, phone: c.phone, reason: "Chart number already exists" }); continue; }
    if (seenPhones.has(c.phone)) { duplicates.push({ row: c.rowNum, phone: c.phone, reason: "Duplicate mobile in file" }); continue; }
    if (chart && seenCharts.has(chart)) { duplicates.push({ row: c.rowNum, phone: c.phone, reason: "Duplicate chart number in file" }); continue; }
    seenPhones.add(c.phone);
    if (chart) seenCharts.add(chart);
    toCreate.push(c.data);
  }

  return { total: rows.length, invalid, duplicates, toCreate };
}

// Segment rules arrive as a JSON-encoded `filter` query param — a nested rule
// object doesn't survive flat query encoding, and sending it as JSON keeps this
// endpoint speaking exactly the same grammar as /api/segments/preview. A
// malformed value is a 400, never a silently ignored filter that would show the
// user the whole database while they believe they are looking at a segment.
function parseFilterParam(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    validateDefinition(parsed);
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("filter must be valid JSON of the form { match, rules }", 400);
  }
}

const getAllCustomers = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const definition = parseFilterParam(req.query.filter);
    const where = await buildCustomerWhere(definition, {
      search: req.query.search,
      excludeOptedOut: req.query.excludeOptedOut === "true",
    });

    const [customers, total] = await Promise.all([
      // id tiebreaker keeps pagination stable when many rows share a createdAt
      // (e.g. a bulk import), otherwise skip/take can repeat or drop rows.
      prisma.customer.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: limit }),
      prisma.customer.count({ where }),
    ]);

    res.status(200).json({
      success: true,
      data: customers,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// Every id matching the current filter, not just the current page. "Select all
// 1,284 matches" has to mean all of them — resolving it client-side from a
// paged list is how a campaign quietly goes out to the 20 people on screen.
// Capped so one request can't try to materialise an unbounded audience.
const MAX_RESOLVED_IDS = 20000;

const getFilteredCustomerIds = async (req, res, next) => {
  try {
    const definition = parseFilterParam(req.query.filter);
    const where = await buildCustomerWhere(definition, {
      search: req.query.search,
      excludeOptedOut: req.query.excludeOptedOut === "true",
    });

    const total = await prisma.customer.count({ where });
    if (total > MAX_RESOLVED_IDS) {
      return next(
        new AppError(
          `That filter matches ${total.toLocaleString()} contacts — narrow it below ${MAX_RESOLVED_IDS.toLocaleString()} before selecting them all`,
          400,
        ),
      );
    }

    const rows = await prisma.customer.findMany({ where, select: { id: true }, orderBy: { id: "asc" } });
    res.status(200).json({ success: true, data: { customerIds: rows.map((r) => r.id), count: rows.length } });
  } catch (err) {
    next(err);
  }
};

const getCustomerById = async (req, res, next) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: parseInt(req.params.id) } });
    if (!customer) return next(new AppError("Customer not found", 404));
    res.status(200).json({ success: true, data: customer });
  } catch (err) {
    next(err);
  }
};

const createCustomer = async (req, res, next) => {
  try {
    let { name, phone, email, tags, notes, chartNumber, nationality, gender, dateOfBirth, joinDate, departments } = req.body;
    if (!phone) return next(new AppError("Phone number is required", 400));
    // Same normalisation as CSV import (digits, international, no "+"), so a
    // hand-added "+971 50…" or "050…" matches the digits Meta sends back.
    const norm = normalizeImportPhone(phone, "AE");
    if (norm.error) return next(new AppError(`Phone number: ${norm.error}`, 400));
    phone = norm.phone;

    const genderVal = parseGender(gender);
    if (genderVal === undefined) return next(new AppError("Gender must be 'Male' or 'Female'", 400));
    const dob = parseDate(dateOfBirth);
    if (dob === undefined) return next(new AppError("Invalid date of birth", 400));
    const join = parseDate(joinDate);
    if (join === undefined) return next(new AppError("Invalid join date", 400));

    const existing = await prisma.customer.findUnique({ where: { phone } });
    if (existing) return next(new AppError("Customer with this phone already exists", 409));

    const customer = await prisma.customer.create({
      data: {
        name,
        phone,
        email: email || null,
        chartNumber: chartNumber?.trim() || null,
        nationality: nationality?.trim() || null,
        gender: genderVal,
        dateOfBirth: dob,
        joinDate: join,
        departments: toStringArray(departments),
        tags: Array.isArray(tags) ? tags : [],
        notes: notes || null,
      },
    });
    res.status(201).json({ success: true, data: customer });
  } catch (err) {
    if (err.code === "P2002") {
      const target = err.meta?.target?.join?.(", ") || "field";
      return next(new AppError(`A customer with this ${target} already exists`, 409));
    }
    next(err);
  }
};

const updateCustomer = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    let { name, phone, email, tags, notes, optedOut, chartNumber, nationality, gender, dateOfBirth, joinDate, departments } = req.body;

    // Validate phone uniqueness before updating
    if (phone !== undefined) {
      const norm = normalizeImportPhone(phone, "AE");
      if (norm.error) return next(new AppError(`Phone number: ${norm.error}`, 400));
      phone = norm.phone;
      const conflict = await prisma.customer.findFirst({
        where: { phone, id: { not: id } },
      });
      if (conflict) return next(new AppError("Phone number is already in use by another customer", 409));
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email;
    if (chartNumber !== undefined) data.chartNumber = chartNumber?.trim() || null;
    if (nationality !== undefined) data.nationality = nationality?.trim() || null;
    if (gender !== undefined) {
      const genderVal = parseGender(gender);
      if (genderVal === undefined) return next(new AppError("Gender must be 'Male' or 'Female'", 400));
      data.gender = genderVal;
    }
    if (dateOfBirth !== undefined) {
      const dob = parseDate(dateOfBirth);
      if (dob === undefined) return next(new AppError("Invalid date of birth", 400));
      data.dateOfBirth = dob;
    }
    if (joinDate !== undefined) {
      const join = parseDate(joinDate);
      if (join === undefined) return next(new AppError("Invalid join date", 400));
      data.joinDate = join;
    }
    if (departments !== undefined) data.departments = toStringArray(departments);
    if (tags !== undefined) data.tags = Array.isArray(tags) ? tags : [];
    if (notes !== undefined) data.notes = notes;
    if (optedOut !== undefined) data.optedOut = Boolean(optedOut);

    const customer = await prisma.customer.update({
      where: { id },
      data,
    });
    res.status(200).json({ success: true, data: customer });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Customer not found", 404));
    if (err.code === "P2002") {
      const target = err.meta?.target?.join?.(", ") || "field";
      return next(new AppError(`A customer with this ${target} already exists`, 409));
    }
    next(err);
  }
};

// Dry-run: validate & categorize the upload without writing anything.
const validateImport = async (req, res, next) => {
  try {
    const rows = parseUpload(req);
    const plan = await buildImportPlan(rows, req.body?.dateFormat, req.body?.defaultCountry);
    res.status(200).json({
      success: true,
      data: {
        total: plan.total,
        valid: plan.toCreate.length,
        duplicates: plan.duplicates,
        invalid: plan.invalid,
      },
    });
  } catch (err) {
    next(err);
  }
};

// Real import: categorize, then bulk-insert the valid, non-duplicate rows.
const importCustomers = async (req, res, next) => {
  try {
    const rows = parseUpload(req);
    const plan = await buildImportPlan(rows, req.body?.dateFormat, req.body?.defaultCountry);

    let created = 0;
    if (plan.toCreate.length > 0) {
      const result = await prisma.customer.createMany({ data: plan.toCreate, skipDuplicates: true });
      created = result.count;
    }
    const otherSkipped = plan.toCreate.length - created; // e.g. chart-number conflicts

    res.status(200).json({
      success: true,
      data: {
        total: plan.total,
        created,
        skipped: plan.duplicates.length + otherSkipped,
        duplicates: plan.duplicates,
        errors: plan.invalid,
      },
    });
  } catch (err) {
    next(err);
  }
};

const deleteCustomer = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversation: { customerId: id } } }),
      prisma.conversation.deleteMany({ where: { customerId: id } }),
      prisma.campaignRecipient.deleteMany({ where: { customerId: id } }),
      prisma.customer.delete({ where: { id } }),
    ]);
    res.status(200).json({ success: true, message: "Customer deleted" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Customer not found", 404));
    next(err);
  }
};

// Delete many customers at once. Mirrors deleteCustomer's cascade, generalised
// with `{ in: ids }`. Capped at 5000 per request to match the import limit and
// keep the transaction bounded. Missing ids are ignored (deleteMany, not delete).
const bulkDeleteCustomers = async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return next(new AppError("Provide a non-empty array of customer ids", 400));
    }
    const parsed = [...new Set(ids.map((n) => parseInt(n)).filter((n) => Number.isInteger(n)))];
    if (parsed.length === 0) return next(new AppError("No valid customer ids provided", 400));
    if (parsed.length > 5000) return next(new AppError("Cannot delete more than 5000 customers per request", 400));

    const results = await prisma.$transaction([
      prisma.message.deleteMany({ where: { conversation: { customerId: { in: parsed } } } }),
      prisma.conversation.deleteMany({ where: { customerId: { in: parsed } } }),
      prisma.campaignRecipient.deleteMany({ where: { customerId: { in: parsed } } }),
      prisma.customer.deleteMany({ where: { id: { in: parsed } } }),
    ]);
    const deleted = results[results.length - 1].count;
    res.status(200).json({ success: true, message: `Deleted ${deleted} customer(s)`, data: { deleted } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getAllCustomers, getFilteredCustomerIds, getCustomerById, createCustomer, updateCustomer, validateImport, importCustomers, deleteCustomer, bulkDeleteCustomers };
