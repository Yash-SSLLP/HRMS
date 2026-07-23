/**
 * Salary-structure controller — CRUD for named CTC templates whose components are
 * expressed as percentages (basic, HRA, special allowance, conveyance, medical,
 * LTA). Validates that component percentages never exceed 100%, and can preview a
 * full monthly/annual breakup for a given annual CTC.
 */
const asyncHandler = require('express-async-handler');
const SalaryStructure = require('../models/SalaryStructure');
const EmployeeProfile = require('../models/EmployeeProfile');

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
  if (total > 100) {
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
    if (total > 100) {
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
 * employees.manage permission — mirrors the Monthly Payroll Run salary setup.
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
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
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

module.exports = {
  listStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
  assignStructure,
};
