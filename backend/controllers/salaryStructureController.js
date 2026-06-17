const asyncHandler = require('express-async-handler');
const SalaryStructure = require('../models/SalaryStructure');

// Sum the six component percentages from an arbitrary components object.
const sumComponentPct = (c = {}) =>
  (Number(c.basicPct) || 0) +
  (Number(c.hraPct) || 0) +
  (Number(c.specialAllowancePct) || 0) +
  (Number(c.conveyancePct) || 0) +
  (Number(c.medicalPct) || 0) +
  (Number(c.ltaPct) || 0);

// GET /api/salary-structures
const listStructures = asyncHandler(async (req, res) => {
  const structures = await SalaryStructure.find().sort({ name: 1 });
  res.json({ count: structures.length, structures });
});

// POST /api/salary-structures
const createStructure = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }

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

  delete req.body.createdBy;
  Object.assign(structure, req.body);
  await structure.save();
  res.json({ structure });
});

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

module.exports = {
  listStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
};
