const asyncHandler = require('express-async-handler');
const InvestmentDeclaration = require('../models/InvestmentDeclaration');
const { DECLARATION_STATUSES, REGIMES } = require('../models/InvestmentDeclaration');

const EMPLOYEE_FIELDS = 'firstName lastName email';

const SECTION_KEYS = [
  'section80C',
  'section80CCD1B',
  'section80D',
  'section24B',
  'section80E',
  'section80G',
  'hraAnnualRent',
  'ltaClaimed',
  'otherDeductions',
];

// Coerce an incoming sections object into clean non-negative numbers.
function cleanSections(input = {}) {
  const out = {};
  SECTION_KEYS.forEach((key) => {
    const raw = Number(input[key]);
    out[key] = Number.isFinite(raw) && raw > 0 ? raw : 0;
  });
  return out;
}

// Coerce incoming proofs into [{ label, url }] dropping empty rows.
function cleanProofs(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((p) => ({ label: String(p?.label || '').trim(), url: String(p?.url || '').trim() }))
    .filter((p) => p.label || p.url);
}

// GET /api/declarations/me?financialYear=
// Returns the caller's declaration for that FY (or the latest if not specified).
const getMine = asyncHandler(async (req, res) => {
  const { financialYear } = req.query;
  const filter = { employee: req.user._id };
  if (financialYear) filter.financialYear = financialYear;

  const declaration = await InvestmentDeclaration.findOne(filter).sort({ updatedAt: -1 });
  res.json({ declaration });
});

// POST /api/declarations/me  { financialYear, regime, sections, proofs }
// Upsert the caller's draft. Only when current status is Draft/Rejected/absent.
const saveMine = asyncHandler(async (req, res) => {
  const { financialYear, regime, sections, proofs } = req.body;
  if (!financialYear) {
    res.status(400);
    throw new Error('financialYear is required');
  }

  let declaration = await InvestmentDeclaration.findOne({
    employee: req.user._id,
    financialYear,
  });

  if (declaration && !['Draft', 'Rejected'].includes(declaration.status)) {
    res.status(400);
    throw new Error('Already submitted');
  }

  if (!declaration) {
    declaration = new InvestmentDeclaration({
      employee: req.user._id,
      financialYear,
    });
  }

  declaration.regime = REGIMES.includes(regime) ? regime : 'Old';
  declaration.sections = cleanSections(sections);
  declaration.proofs = cleanProofs(proofs);
  declaration.status = 'Draft';

  await declaration.save();
  res.json({ declaration });
});

// PATCH /api/declarations/me/submit  { financialYear }
const submitMine = asyncHandler(async (req, res) => {
  const { financialYear } = req.body;
  if (!financialYear) {
    res.status(400);
    throw new Error('financialYear is required');
  }

  const declaration = await InvestmentDeclaration.findOne({
    employee: req.user._id,
    financialYear,
  });
  if (!declaration) {
    res.status(404);
    throw new Error('No declaration found for that financial year');
  }
  if (!['Draft', 'Rejected'].includes(declaration.status)) {
    res.status(400);
    throw new Error('Already submitted');
  }

  declaration.status = 'Submitted';
  await declaration.save();
  res.json({ declaration });
});

// GET /api/declarations?status=&financialYear=  (admin)
const listAll = asyncHandler(async (req, res) => {
  const { status, financialYear } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (financialYear) filter.financialYear = financialYear;

  const declarations = await InvestmentDeclaration.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .sort({ updatedAt: -1 });
  res.json({ count: declarations.length, declarations });
});

// PATCH /api/declarations/:id/status  { status: Verified|Rejected, reviewNote }  (admin)
const reviewDeclaration = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;
  if (!['Verified', 'Rejected'].includes(status)) {
    res.status(400);
    throw new Error('status must be Verified or Rejected');
  }

  const declaration = await InvestmentDeclaration.findById(req.params.id);
  if (!declaration) {
    res.status(404);
    throw new Error('Declaration not found');
  }

  declaration.status = status;
  declaration.reviewNote = reviewNote || '';
  declaration.reviewedBy = req.user._id;
  declaration.reviewedAt = new Date();

  await declaration.save();
  res.json({ declaration });
});

module.exports = {
  getMine,
  saveMine,
  submitMine,
  listAll,
  reviewDeclaration,
};
