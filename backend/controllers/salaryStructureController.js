/**
 * Salary-structure controller — CRUD for named CTC templates whose components are
 * expressed as percentages (basic, HRA, special allowance, conveyance, medical,
 * LTA). Validates that component percentages never exceed 100%, and can preview a
 * full monthly/annual breakup for a given annual CTC.
 */
const asyncHandler = require('express-async-handler');
const SalaryStructure = require('../models/SalaryStructure');
const EmployeeProfile = require('../models/EmployeeProfile');
const {
  cannotManageProfile, assertCanEditProfileOf, employeeProfileScope,
} = require('../utils/employeeScope');
const { squash, normalizeCode } = require('../utils/loginIdentity');
const {
  COMPONENTS, writeWorkbook, parseWorkbook, monthlyFromComponents,
} = require('../services/salaryStructureExcel');

/**
 * The most a component total may exceed 100 and still count as 100.
 *
 * Six percentages carried to six decimals cannot always be added back to
 * exactly 100 in floating point — a fully-allocated structure lands on
 * 100.00000000000001 about one time in eight. A strict `> 100` refuses those,
 * so a structure would save once and then refuse to save again the first time
 * somebody opened it and pressed Save. A millionth of a percent is a fraction of
 * a paisa on any salary; a real over-allocation is never this small.
 */
const PCT_TOTAL_EPSILON = 1e-6;

// Sum the six component percentages from an arbitrary components object.
const sumComponentPct = (c = {}) =>
  (Number(c.basicPct) || 0) +
  (Number(c.hraPct) || 0) +
  (Number(c.specialAllowancePct) || 0) +
  (Number(c.conveyancePct) || 0) +
  (Number(c.medicalPct) || 0) +
  (Number(c.ltaPct) || 0);

/**
 * List all salary structures, alphabetically.
 * @route GET /api/salary-structures
 * @returns {{count: number, structures: Object[]}}
 */
// GET /api/salary-structures
const listStructures = asyncHandler(async (req, res) => {
  const structures = await SalaryStructure.find().sort({ name: 1 });
  res.json({ count: structures.length, structures });
});

/**
 * Create a salary structure (unique name; component percentages must total <=100).
 * @route POST /api/salary-structures
 * @param {string} req.body.name - required, unique
 * @param {Object} [req.body.components] - percentage components
 * @returns {{structure: Object}} the created structure (201); 409 if name exists
 */
// POST /api/salary-structures
const createStructure = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }

  // Guard: the six percentage components cannot exceed the full 100% of CTC
  const total = sumComponentPct(req.body.components);
  if (total > 100 + PCT_TOTAL_EPSILON) {
    res.status(400);
    throw new Error(`Component percentages add up to ${total}%, which exceeds 100%`);
  }

  const exists = await SalaryStructure.findOne({ name: name.trim() });
  if (exists) {
    res.status(409);
    throw new Error('A salary structure with that name already exists');
  }

  const structure = await SalaryStructure.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ structure });
});

/**
 * Update a salary structure (partial); re-validates component totals if changed.
 * @route PUT /api/salary-structures/:id
 * @param {string} req.params.id - structure id
 * @param {Object} req.body - fields to update
 * @returns {{structure: Object}} the updated structure
 */
// PUT /api/salary-structures/:id
const updateStructure = asyncHandler(async (req, res) => {
  const structure = await SalaryStructure.findById(req.params.id);
  if (!structure) {
    res.status(404);
    throw new Error('Salary structure not found');
  }

  if (req.body.components) {
    const total = sumComponentPct(req.body.components);
    if (total > 100 + PCT_TOTAL_EPSILON) {
      res.status(400);
      throw new Error(`Component percentages add up to ${total}%, which exceeds 100%`);
    }
  }

  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(structure, req.body);
  await structure.save();
  res.json({ structure });
});

/**
 * Delete a salary structure by id.
 * @route DELETE /api/salary-structures/:id
 * @param {string} req.params.id - structure id
 * @returns {{id: string, deleted: boolean}}
 */
// DELETE /api/salary-structures/:id
const deleteStructure = asyncHandler(async (req, res) => {
  const structure = await SalaryStructure.findById(req.params.id);
  if (!structure) {
    res.status(404);
    throw new Error('Salary structure not found');
  }
  await structure.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Preview the full salary breakup a structure produces for a given annual CTC.
 * @route POST /api/salary-structures/:id/preview
 * @param {string} req.params.id - structure id
 * @param {number} req.body.annualCtc - the annual CTC to apply percentages to
 * @returns {{annualCtc, monthly, annual, monthlyGross, annualGross}} per-component amounts
 */
// POST /api/salary-structures/:id/preview  { annualCtc }
const previewStructure = asyncHandler(async (req, res) => {
  const structure = await SalaryStructure.findById(req.params.id);
  if (!structure) {
    res.status(404);
    throw new Error('Salary structure not found');
  }

  const ctc = Number(req.body.annualCtc) || 0;
  const c = structure.components || {};

  const annualOf = (pct) => ctc * ((Number(pct) || 0) / 100);

  const annual = {
    basic: annualOf(c.basicPct),
    hra: annualOf(c.hraPct),
    specialAllowance: annualOf(c.specialAllowancePct),
    conveyance: annualOf(c.conveyancePct),
    medical: annualOf(c.medicalPct),
    lta: annualOf(c.ltaPct),
  };

  const monthly = {
    basic: annual.basic / 12,
    hra: annual.hra / 12,
    specialAllowance: annual.specialAllowance / 12,
    conveyance: annual.conveyance / 12,
    medical: annual.medical / 12,
    lta: annual.lta / 12,
  };

  const annualGross =
    annual.basic + annual.hra + annual.specialAllowance + annual.conveyance + annual.medical + annual.lta;
  const monthlyGross = annualGross / 12;

  res.json({ annualCtc: ctc, monthly, annual, monthlyGross, annualGross });
});

/**
 * Assign this salary structure to an employee (optionally set their annual CTC).
 * Payroll's own way to set an employee's salary basis without needing the broader
 * employees.manage permission — mirrors the Hikes page salary setup.
 * @route POST /api/salary-structures/:id/assign  (payroll.manage)
 * @param {string} req.params.id - structure id
 * @param {string} req.body.employee - EmployeeProfile id (required)
 * @param {number} [req.body.annualCtc] - set the CTC too; omit/blank to keep the current one
 * @returns {{ok: true, employee, annualCtc}}
 */
const assignStructure = asyncHandler(async (req, res) => {
  const structure = await SalaryStructure.findById(req.params.id);
  if (!structure) {
    res.status(404);
    throw new Error('Salary structure not found');
  }
  const { employee, annualCtc } = req.body;
  if (!employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  const profile = await EmployeeProfile.findById(employee);
  // Same per-record wall the rest of the portal applies: an admin may only set
  // the salary basis of somebody who is theirs to look after (HR partner /
  // company). Reads as not-found so another company's headcount stays hidden.
  if (!profile || cannotManageProfile(req, profile)) {
    res.status(404);
    throw new Error('Employee not found');
  }
  // Putting a Manager on a salary structure — and with it their CTC — is a
  // change to a Manager's record, so it needs the manager-profile grant.
  await assertCanEditProfileOf(req, profile);
  profile.salaryStructure = structure._id;
  if (annualCtc !== undefined && annualCtc !== null && annualCtc !== '') {
    const ctc = Number(annualCtc);
    if (!Number.isFinite(ctc) || ctc < 0) {
      res.status(400);
      throw new Error('Enter a valid annual CTC');
    }
    profile.annualCtc = ctc;
  }
  await profile.save();
  res.json({ ok: true, employee: profile._id, annualCtc: profile.annualCtc });
});

// ===== Bulk Excel: template, export, import =====

// Case-insensitive exact match on a structure name, escaped so a name carrying a
// bracket cannot become a pattern.
const escapeRegExp = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactName = (name) => new RegExp(`^${escapeRegExp(String(name).trim())}$`, 'i');

const displayName = (profile) => `${profile?.user?.firstName || ''} ${profile?.user?.lastName || ''}`.trim();

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** The CTC a row is asking for, rounded the way it will be stored. */
const newCtcFor = (row) => Math.round(Number(row.annualCtc) || 0);

/**
 * The annual CTC in force for this employee THIS month — payroll's own answer,
 * not the `annualCtc` field.
 *
 * The field is documented as "effective as of today", and for an employee with
 * no revision history it is exactly that. Once a hike has been recorded, though,
 * only `giveHike` maintains it, and only when the revision is effective on the
 * day it is entered: a hike dated three months ahead leaves the field behind
 * for good, while `resolveCtcForMonth` correctly starts paying the new figure
 * when its month arrives. Everything here — the sheet's own CTC column and the
 * "did this row change anything" test — has to agree with what is being PAID.
 *
 * The require is lazy on purpose: payrollController is a large module and this
 * keeps the load order one-directional (it never requires this controller).
 * @param {Object} profile - EmployeeProfile with ctcHistory
 * @param {Date} [now]
 * @returns {number}
 */
const inForceCtc = (profile, now = new Date()) => {
  const { resolveCtcForMonth } = require('./payrollController');
  return resolveCtcForMonth(profile, now.getFullYear(), now.getMonth() + 1) || 0;
};

/**
 * Do these stored percentages pay exactly what this row says, to the rupee?
 *
 * Deliberately compared in MONEY, not in percentage points. A percentage
 * tolerance is a money tolerance wearing a disguise — a hundredth of a point is
 * ₹10 a month at a ₹12L CTC and ₹100 at ₹1.2cr — and the question being asked
 * here is only ever "would this employee be paid the same?". It also makes a
 * re-imported EXPORT a true no-op: the export writes whole rupees, so
 * re-deriving the percentages from them drifts by up to 0.014 of a point on a
 * small CTC, which any percentage tolerance tight enough to be meaningful would
 * read as a different structure and clone.
 *
 * @param {Object} components - a SalaryStructure's stored percentages
 * @param {{monthly: Object}} row - the parsed sheet row
 * @param {number} annualCtc - the CTC the amounts belong to
 * @returns {boolean}
 */
const paysTheSame = (components, row, annualCtc) => {
  if (!components || !row.monthly || !annualCtc) return false;
  const paid = monthlyFromComponents(components, annualCtc);
  return COMPONENTS.every((c) => paid[c.key] === Math.round(Number(row.monthly[c.key]) || 0));
};

/**
 * Do two names refer to the same person, allowing for how a spreadsheet writes
 * them? Case, punctuation, double spaces and word ORDER are all ignored
 * ("Patel Asha" is "Asha Patel"), because none of those is a different person —
 * while a genuinely different name still disagrees.
 * @param {string} a @param {string} b
 * @returns {boolean}
 */
const namesAgree = (a, b) => {
  const parts = (v) => String(v || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  const x = parts(a);
  const y = parts(b);
  return !x || !y || x === y;
};

/**
 * The employees this admin may see, with everything the sheet needs.
 * Scoped exactly like the directory: an HR Manager gets their own assigned
 * people, a company-limited CEO/MD their companies, the Backend everyone.
 * @param {import('express').Request} req
 * @returns {Promise<Object[]>} EmployeeProfile docs with user + salaryStructure populated
 */
const scopedProfiles = (req) => EmployeeProfile.find(employeeProfileScope(req))
  // hrPartner and company are in this list because cannotManageProfile READS
  // them: without hrPartner every row would be refused as "not yours" for the
  // one role this feature exists for, an HR Manager. `user.role` is populated
  // for the same reason — assertCanEditProfileOf uses an already-loaded role and
  // otherwise falls back to a User lookup per row.
  .select('employeeCode user salaryStructure annualCtc ctcHistory company hrPartner department designation')
  .populate('user', 'firstName lastName email isActive role')
  .populate('salaryStructure', 'name components isActive')
  .sort({ employeeCode: 1 });

/**
 * Download the salary sheet: one row per employee, showing the monthly amounts
 * their structure and CTC actually produce, plus a reference sheet of every
 * template. Re-uploadable as it stands — the export IS the import format.
 * @route GET /api/salary-structures/export.xlsx  (payroll.manage)
 * @returns {xlsx}
 */
const exportStructuresXlsx = asyncHandler(async (req, res) => {
  const [profiles, structures] = await Promise.all([
    scopedProfiles(req),
    SalaryStructure.find().sort({ name: 1 }).lean(),
  ]);
  // The CTC IN FORCE this month, not the stored field — see inForceCtc. An
  // employee whose hike has matured is paid a figure `annualCtc` no longer
  // carries, and exporting the stale one would both misreport their salary and
  // invite an edit that cancels the hike on the way back in.
  const now = new Date();
  const rows = profiles.map((p) => ({
    employeeName: displayName(p),
    employeeCode: p.employeeCode,
    structureName: p.salaryStructure?.name || '',
    annualCtc: inForceCtc(p, now),
    components: p.salaryStructure?.components || {},
  }));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="salary-structures-${stamp}.xlsx"`);
  await writeWorkbook(res, rows, { structures });
});

/**
 * Download the blank import template: the headers, one example row, and the
 * reference sheet of existing structures to name in the Salary Structure column.
 * @route GET /api/salary-structures/template.xlsx  (payroll.manage)
 * @returns {xlsx}
 */
const downloadImportTemplate = asyncHandler(async (req, res) => {
  const structures = await SalaryStructure.find().sort({ name: 1 }).lean();
  res.setHeader('Content-Disposition', 'attachment; filename="salary-structure-import-template.xlsx"');
  await writeWorkbook(res, [], { includeSample: true, structures });
});

/**
 * Bulk-load salary structures from a spreadsheet and put people on them.
 *
 * One row is one person's breakup. For each row, in order:
 *   1. find the employee — SSL Code first (exact, then ignoring spaces and
 *      case), falling back to an UNAMBIGUOUS name match;
 *   2. turn the monthly amounts into percentages of the annual CTC
 *      (services/salaryStructureExcel does the arithmetic and the unit check);
 *   3. find or create the named structure — the person's own name when the
 *      Salary Structure column is blank, which is how this portal already names
 *      per-employee templates;
 *   4. put the employee on it and set their CTC.
 *
 * A row NEVER takes the sheet down with it: every failure is collected against
 * its Excel row number and reported, so HR fixes those rows and re-uploads.
 * Re-uploading is safe by design — the same sheet twice leaves the same state.
 *
 * @route POST /api/salary-structures/import  (payroll.manage, multipart field "file")
 * @returns {{total, createdCount, updatedCount, assignedCount, skippedCount, errorCount,
 *   created, updated, assigned, skipped, errors, notes}}
 */
const importStructuresXlsx = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('Excel file is required (multipart field "file")');
  }
  let rows;
  let missingComponents = [];
  let ambiguousColumns = [];
  try {
    ({ rows, missingComponents, ambiguousColumns = [] } = await parseWorkbook(req.file.buffer));
  } catch (err) {
    res.status(400);
    throw new Error(`Could not read workbook: ${err.message}`);
  }
  if (!rows.length) {
    res.status(400);
    throw new Error('No data rows found. The first row must be the header.');
  }

  // The people this admin may touch, loaded once — a per-row findOne would be
  // one query per row AND would reach employees outside their scope.
  const profiles = await scopedProfiles(req);
  const byCode = new Map();
  const bySquashedCode = new Map();
  const byName = new Map();      // lower-case name -> [profiles] (may be several)
  for (const p of profiles) {
    if (p.employeeCode) {
      byCode.set(normalizeCode(p.employeeCode), p);
      bySquashedCode.set(squash(p.employeeCode), p);
    }
    const n = displayName(p).toLowerCase();
    if (n) byName.set(n, [...(byName.get(n) || []), p]);
  }

  // Structures are cached by lower-case name for the same reason, and the cache
  // is updated as rows create them, so two rows naming the same new template
  // share one document instead of racing to create two.
  const structureCache = new Map();
  for (const st of await SalaryStructure.find()) structureCache.set(st.name.trim().toLowerCase(), st);

  // How many people were on each structure BEFORE this upload started, counted
  // once. Counting inside the loop reads a collection the loop is itself
  // mutating: rows 2 and 3 move the only other holders onto forks of their own,
  // and row 4 then finds the template "solo" and reprices it in place — the
  // outcome depending on the order the sheet happened to be in.
  const holdersAtStart = new Map();
  for (const g of await EmployeeProfile.aggregate([
    { $match: { salaryStructure: { $ne: null } } },
    { $group: { _id: '$salaryStructure', n: { $sum: 1 } } },
  ])) holdersAtStart.set(String(g._id), g.n);

  /** People OTHER than this employee who were on `structure` when the upload began. */
  const otherHolders = (structure, profile) => {
    const total = holdersAtStart.get(String(structure._id)) || 0;
    const wasOnIt = String(profile.salaryStructure?._id || profile.salaryStructure || '') === String(structure._id);
    return Math.max(0, total - (wasOnIt ? 1 : 0));
  };

  const created = [];
  const updated = [];
  const assigned = [];
  const skipped = [];
  const errors = [];
  const notes = [];
  // Which row already set each person up. A sheet listing somebody twice is an
  // ordinary copy-paste, and taking the last row silently would quietly pay them
  // whatever that row happened to say — so the second one is refused by name.
  const seen = new Map();

  const fail = (row, message) => errors.push({
    excelRow: row.excelRow,
    name: row.employeeName || row.employeeCode || '',
    message,
  });

  for (const row of rows) {
    try {
      if (row.error) { fail(row, row.error); continue; }

      // ----- 1. Who is this row about? -----
      let profile = null;
      if (row.employeeCode) {
        profile = byCode.get(normalizeCode(row.employeeCode))
          // "SSL 120" and "SSL120" are the same code to a person, and both get
          // typed. squash() is the comparison the login screen already makes.
          || bySquashedCode.get(squash(row.employeeCode))
          || null;
        if (!profile) {
          fail(row, `No employee with SSL Code "${row.employeeCode}"${row.employeeName ? ` (${row.employeeName})` : ''}. `
            + 'Check the code, and that they are one of yours.');
          continue;
        }
        // The Name column is not used to FIND anybody, but it is used to check
        // the finding. A sheet pasted one row out of alignment matches every
        // code perfectly and reprices the wrong people; the names are what
        // disagree, so a row whose two identifiers point at different people is
        // refused rather than applied.
        if (row.employeeName && !namesAgree(row.employeeName, displayName(profile))) {
          fail(row, `SSL Code ${row.employeeCode} is ${displayName(profile)}, but this row is named `
            + `"${row.employeeName}". Check the sheet is not shifted by a row.`);
          continue;
        }
      } else {
        const matches = byName.get(row.employeeName.toLowerCase()) || [];
        if (matches.length === 1) {
          [profile] = matches;
          notes.push({
            excelRow: row.excelRow,
            message: `Matched "${row.employeeName}" by name — add their SSL Code to be certain.`,
          });
        } else if (matches.length > 1) {
          fail(row, `${matches.length} employees are called "${row.employeeName}". Add the SSL Code so the right one is picked.`);
          continue;
        } else {
          fail(row, `No employee called "${row.employeeName}". Add their SSL Code, or check the spelling.`);
          continue;
        }
      }

      // Same per-record wall as the single assign: nobody sets their own salary,
      // and a Manager's record needs the manager-profile grant. The second one
      // throws, and the throw is caught per row so one protected record cannot
      // stop the sheet.
      if (cannotManageProfile(req, profile)) {
        skipped.push({
          excelRow: row.excelRow,
          name: displayName(profile),
          employeeCode: profile.employeeCode,
          reason: 'You cannot set this salary — your own record, or an employee who is not yours',
        });
        continue;
      }
      await assertCanEditProfileOf(req, profile);

      const earlier = seen.get(String(profile._id));
      if (earlier) {
        fail(row, `Row ${earlier} already sets up ${displayName(profile)} (${profile.employeeCode}). `
          + 'Delete one of the two rows — whichever is right — and upload again.');
        continue;
      }
      seen.set(String(profile._id), row.excelRow);

      // ----- 2. Which template? -----
      // Blank column then the person's own name, which is how HR already names a
      // per-employee structure on this page.
      const wanted = (row.structureName || displayName(profile) || row.employeeName).trim();
      if (!wanted) { fail(row, 'No Salary Structure name, and no employee name to use as one'); continue; }

      const total = row.totalPct;
      if (total > 100 + PCT_TOTAL_EPSILON) {
        fail(row, `The components come to ${total}% of CTC, which is more than the whole CTC`);
        continue;
      }

      // The structure they are ALREADY on wins, if it still pays this row's
      // amounts. Keying on the employee's pointer rather than on the name is what
      // makes a re-upload a no-op after somebody has renamed a template: matching
      // by name alone would mint "Asha Patel" again beside the "Senior Band A"
      // she was deliberately moved to, and re-point her at it.
      // …but only when the sheet did not NAME one. A filled-in Salary Structure
      // column is an instruction — "put these people on this template" — and it
      // has to win over a default, even when the template they are already on
      // happens to pay the same amounts.
      const current = profile.salaryStructure;
      const currentMatches = !row.structureName
        && !!current?.components
        && paysTheSame(current.components, row, newCtcFor(row));

      let structure = currentMatches
        ? current
        : structureCache.get(wanted.toLowerCase()) || await SalaryStructure.findOne({ name: exactName(wanted) });

      if (!structure) {
        structure = await SalaryStructure.create({
          name: wanted,
          description: `Imported from a salary sheet · ${total}% of CTC`,
          components: row.components,
          createdBy: req.user._id,
        });
        created.push({ excelRow: row.excelRow, name: structure.name, totalPct: total });
      } else {
        // The template exists. Rewriting its percentages changes the pay of
        // EVERYONE on it, so that is only allowed when this row is the only
        // person it would affect. Otherwise the shared template is left alone
        // and this employee gets one of their own, with the clash reported.
        const sameSplit = paysTheSame(structure.components, row, newCtcFor(row));
        if (!sameSplit) {
          const others = otherHolders(structure, profile);
          if (others === 0) {
            structure.components = row.components;
            await structure.save();
            updated.push({ excelRow: row.excelRow, name: structure.name, totalPct: total });
          } else {
            const ownName = `${displayName(profile) || row.employeeName} (${profile.employeeCode})`;
            let own = structureCache.get(ownName.toLowerCase())
              || await SalaryStructure.findOne({ name: exactName(ownName) });
            if (own) {
              // The fork target is a real structure too, and somebody else may
              // have been put on it by hand. Repricing it here would move their
              // pay to fix this row — the very thing the branch exists to avoid.
              if (otherHolders(own, profile) > 0) {
                fail(row, `"${structure.name}" is shared and cannot take this row's split, and `
                  + `"${ownName}" is shared too. Give this row a Salary Structure name of its own.`);
                continue;
              }
              own.components = row.components;
              await own.save();
              updated.push({ excelRow: row.excelRow, name: own.name, totalPct: total });
            } else {
              own = await SalaryStructure.create({
                name: ownName,
                description: `Imported from a salary sheet · ${total}% of CTC`,
                components: row.components,
                createdBy: req.user._id,
              });
              created.push({ excelRow: row.excelRow, name: own.name, totalPct: total });
            }
            notes.push({
              excelRow: row.excelRow,
              // The COUNT is deliberately not quoted: it is taken unscoped (it has
              // to be — a template must not be repriced because the holders
              // happen to sit outside this admin's company), so printing it
              // would report headcount across the company wall.
              message: `"${structure.name}" is shared with other employees and this row's split differs, `
                + `so it was left alone and ${displayName(profile)} was put on "${ownName}" instead.`,
            });
            structure = own;
          }
        }
      }
      structureCache.set(structure.name.trim().toLowerCase(), structure);

      // ----- 3. Put them on it, with the CTC the row gives -----
      const newCtc = Math.round(Number(row.annualCtc) || 0);
      // The CTC IN FORCE, not the field. `annualCtc` is only written when a
      // revision is effective on the day it is recorded, so a future-dated hike
      // leaves it permanently behind once its month arrives — payroll pays
      // resolveCtcForMonth and the field still reads the old figure. Comparing
      // against the field would then treat "unchanged" as a change, stamp a
      // revision for THIS month, and — sorting last among revisions with the same
      // month — quietly outrank the hike already in force, for that month and
      // every month after.
      const prevCtc = Number(inForceCtc(profile)) || 0;
      const previousStructure = profile.salaryStructure?._id || profile.salaryStructure || null;
      const structureChanged = String(previousStructure || '') !== String(structure._id);
      // Only written when it actually moves. Re-assigning the same pointer marks
      // the document dirty, so a re-upload of an unchanged 500-row sheet would
      // otherwise be 500 pointless writes to the shared cluster.
      if (structureChanged) profile.salaryStructure = structure._id;

      if (newCtc !== prevCtc) {
        profile.annualCtc = newCtc;
        // A CTC change only reaches payroll through the revision history once an
        // employee HAS one: resolveCtcForMonth takes the latest revision effective
        // on or before the run month and ignores `annualCtc` entirely
        // (payrollController). Writing the field alone would show the new figure
        // on screen while payroll kept paying the old one — the worst kind of
        // silent wrong. So a revision is recorded, exactly as the Hikes page does.
        // ALWAYS, not only when a history already exists.
        //
        // resolveCtcForMonth answers a month before the earliest revision with
        // that revision's `previousCtc`, so one entry {previousCtc: what they
        // were on, newCtc: what the sheet says, effective this month} states the
        // past correctly AND pays the new figure from now on. Writing only
        // `annualCtc` instead — which is what this did — leaves an employee with
        // no history resolving to the NEW figure for every month there has ever
        // been: a re-run of a month already paid silently reprices it.
        {
          const now = new Date();
          profile.ctcHistory = [...(profile.ctcHistory || []), {
            previousCtc: prevCtc,
            newCtc,
            mode: 'set',
            value: newCtc,
            previousStructure,
            newStructure: structure._id,
            effectiveYear: now.getFullYear(),
            effectiveMonth: now.getMonth() + 1,
            reason: 'Bulk salary structure import',
            by: req.user._id,
            byName: req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
            at: now,
          }];
        }
      }
      await profile.save();

      assigned.push({
        excelRow: row.excelRow,
        name: displayName(profile),
        employeeCode: profile.employeeCode,
        structure: structure.name,
        annualCtc: newCtc,
        ctcChanged: newCtc !== prevCtc,
        structureChanged,
        // What the payslip will actually say, recomputed the way payroll does —
        // so the result screen proves the sheet's numbers survived the round trip.
        monthly: monthlyFromComponents(structure.components, newCtc),
      });

      // A revision already recorded for this month or later is outranked by the
      // one this row writes (same month sorts by insertion, and a later month is
      // reached by a re-run). That is a real consequence of a bulk edit and is
      // said out loud rather than discovered on a payslip.
      if (newCtc !== prevCtc) {
        const key = (y, m) => Number(y) * 12 + (Number(m || 1) - 1);
        const thisMonth = key(new Date().getFullYear(), new Date().getMonth() + 1);
        const ahead = (profile.ctcHistory || []).filter((r) => r.effectiveYear && key(r.effectiveYear, r.effectiveMonth) >= thisMonth);
        if (ahead.length) {
          notes.push({
            excelRow: row.excelRow,
            message: `${displayName(profile)} already has a salary revision recorded for `
              + `${MONTHS[ahead[0].effectiveMonth] || ''} ${ahead[0].effectiveYear}. This row's CTC replaces it.`,
          });
        }
      }

      // A rupee or two shaved off the biggest component to fit a fully-allocated
      // sheet under 100% of CTC. Tiny, but it is somebody's pay, so it is said —
      // on a row that actually WROTE something. A re-upload where nothing moved
      // would otherwise report a pay cut that did not happen.
      if (row.trimmed && (structureChanged || newCtc !== prevCtc || created.some((c) => c.excelRow === row.excelRow)
        || updated.some((u) => u.excelRow === row.excelRow))) {
        notes.push({
          excelRow: row.excelRow,
          message: `${displayName(profile)}'s components used every rupee of the CTC and a little more once rounded, `
            + `so ₹${row.trimmed} a month came off ${row.trimmedFrom || 'the largest component'} to fit. `
            + 'That is the CTC not dividing exactly by twelve.',
        });
      }

      if (row.unit === 'annual') {
        notes.push({
          excelRow: row.excelRow,
          message: `The amounts for ${displayName(profile)} added up to a year of pay, so they were read as ANNUAL `
            + 'figures and divided by 12. The template expects monthly amounts.',
        });
      }

      // Components that do not fill the whole CTC are normal — employer PF,
      // gratuity and bonus live in that gap — but the gap is worth naming,
      // because the payroll REGISTER prints CTC/12 as the salary while the
      // payslip prints the sum of these components. Somebody will compare the
      // two, and this is the sentence that explains the difference.
      if (total < 99.5) {
        const gap = Math.round((newCtc * (100 - total)) / 100 / 12);
        notes.push({
          excelRow: row.excelRow,
          message: `${displayName(profile)}'s components come to ${total}% of CTC — ₹${gap.toLocaleString('en-IN')} a month `
            + (missingComponents.length
              // Never call the shortfall normal when the sheet simply had no
              // column for those components: that sentence is what would let a
              // wiped-out allowance pass as expected.
              ? `is unallocated, and this sheet has no ${missingComponents.join(' or ')} column — those are being set to zero.`
              : 'is not allocated to any component. That is normal when the CTC includes employer PF or gratuity, but the '
                + 'payroll register shows CTC ÷ 12 while the payslip shows the components.'),
        });
      }
    } catch (err) {
      fail(row, err.message || 'Row failed');
    }
  }

  // The COUNTS are always the truth; the lists are capped. A 3,000-row sheet of
  // rubbish would otherwise return 3,000 error objects and make the result modal
  // the payload — the reader cannot act on that many anyway, and the first two
  // hundred are enough to see what is wrong with the file.
  const LIST_CAP = 200;
  const cap = (list) => list.slice(0, LIST_CAP);

  res.json({
    total: rows.length,
    createdCount: created.length,
    updatedCount: updated.length,
    assignedCount: assigned.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    listCap: LIST_CAP,
    // Pay columns the sheet did not carry at all. Front and centre in the
    // result: every row imported is paying zero for these.
    missingComponents,
    // Two headers that mean the same column to us, so only the first was read.
    ambiguousColumns,
    created: cap(created),
    updated: cap(updated),
    assigned: cap(assigned),
    skipped: cap(skipped),
    errors: cap(errors),
    notes: cap(notes),
  });
});

module.exports = {
  listStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
  assignStructure,
  exportStructuresXlsx,
  downloadImportTemplate,
  importStructuresXlsx,
};
