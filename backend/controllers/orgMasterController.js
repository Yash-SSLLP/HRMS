const asyncHandler = require('express-async-handler');
const OrgMaster = require('../models/OrgMaster');
const { ORG_MASTER_KINDS } = require('../models/OrgMaster');

// Build a short code from a name: initials for multi-word names, else the word
// itself. e.g. "Area Sales Manager" -> "ASM", "L&D Manager" -> "LDM",
// "HRBP" -> "HRBP", "IT" -> "IT".
function baseCodeFromName(name) {
  const words = String(name || '').trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  let base = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] || '');
  base = base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return base || 'CODE';
}

// A code unique within `kind`, suffixing -2, -3, … on collision. `excludeId`
// skips the document being updated so it doesn't collide with itself.
async function generateUniqueCode(kind, name, excludeId) {
  const base = baseCodeFromName(name);
  const query = { kind, code: new RegExp(`^${base}(-\\d+)?$`, 'i') };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await OrgMaster.find(query).select('code').lean();
  const taken = new Set(existing.map((m) => (m.code || '').toUpperCase()));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const listMasters = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.kind) filter.kind = req.query.kind;
  const masters = await OrgMaster.find(filter).sort({ kind: 1, name: 1 });
  res.json({ count: masters.length, masters });
});

const createMaster = asyncHandler(async (req, res) => {
  const { kind, name, code } = req.body;
  if (!kind || !ORG_MASTER_KINDS.includes(kind) || !name) {
    res.status(400);
    throw new Error('kind (Designation/Grade/Location) and name are required');
  }
  const exists = await OrgMaster.findOne({ kind, name });
  if (exists) {
    res.status(409);
    throw new Error(`A ${kind} with that name already exists`);
  }
  const master = await OrgMaster.create({
    ...req.body,
    // Auto-generate a code when none is supplied.
    code: code ? code.toUpperCase() : await generateUniqueCode(kind, name),
    createdBy: req.user._id,
  });
  res.status(201).json({ master });
});

const updateMaster = asyncHandler(async (req, res) => {
  const master = await OrgMaster.findById(req.params.id);
  if (!master) {
    res.status(404);
    throw new Error('Org master not found');
  }
  delete req.body.createdBy;
  Object.assign(master, req.body);
  // Backfill / regenerate a code if it's blank (e.g. an older row saved without
  // one), based on the current name.
  if (!master.code || !String(master.code).trim()) {
    master.code = await generateUniqueCode(master.kind, master.name, master._id);
  }
  await master.save();
  res.json({ master });
});

const deleteMaster = asyncHandler(async (req, res) => {
  const master = await OrgMaster.findById(req.params.id);
  if (!master) {
    res.status(404);
    throw new Error('Org master not found');
  }
  await master.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listMasters, createMaster, updateMaster, deleteMaster,
};
