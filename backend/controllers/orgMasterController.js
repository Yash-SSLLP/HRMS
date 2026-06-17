const asyncHandler = require('express-async-handler');
const OrgMaster = require('../models/OrgMaster');
const { ORG_MASTER_KINDS } = require('../models/OrgMaster');

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
    code: code ? code.toUpperCase() : undefined,
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
