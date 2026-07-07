const asyncHandler = require('express-async-handler');
const Asset = require('../models/Asset');
const { ASSET_STATUS } = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');

const USER_FIELDS = 'firstName lastName email role';

// ===== HR/Admin =====
const listAssets = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const assets = await Asset.find(filter)
    .populate('assignedTo', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: assets.length, assets });
});

const createAsset = asyncHandler(async (req, res) => {
  const { name, assetTag } = req.body;
  if (!name || !assetTag) {
    res.status(400);
    throw new Error('name and assetTag are required');
  }
  const exists = await Asset.findOne({ assetTag: assetTag.toUpperCase() });
  if (exists) {
    res.status(409);
    throw new Error('An asset with that tag already exists');
  }
  const asset = await Asset.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ asset });
});

const updateAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  delete req.body.createdBy;
  Object.assign(asset, req.body);
  await asset.save();
  res.json({ asset });
});

const deleteAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  await AssetAssignment.deleteMany({ asset: asset._id });
  await asset.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// PATCH /api/assets/:id/assign
//   Give the asset to an employee:  { userId, date?, note? }
//   Return it to stock:             { userId: null|'', date? }  (date = return date)
// Keeps a full assignment history: giving closes any open holding and opens a
// new one; returning closes the open holding with a return date.
const assignAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  const { userId, note } = req.body;
  const when = req.body.date ? new Date(req.body.date) : new Date();

  // Close whatever is currently held (on reassign or return).
  if (asset.assignedTo) {
    await AssetAssignment.updateMany(
      { asset: asset._id, returnedAt: null },
      { $set: { returnedAt: when, returnedBy: req.user._id } }
    );
  }

  if (userId) {
    await AssetAssignment.create({
      asset: asset._id,
      employee: userId,
      assignedAt: when,
      assignedBy: req.user._id,
      note: (note || '').slice(0, 500) || undefined,
    });
    asset.assignedTo = userId;
    asset.assignedAt = when;
    asset.status = 'Assigned';
  } else {
    asset.assignedTo = undefined;
    asset.assignedAt = undefined;
    if (asset.status === 'Assigned') asset.status = 'Available';
  }
  await asset.save();
  res.json({ asset });
});

// GET /api/assets/assignments?active=true&employee=&asset=
// The allocation register: who has (or had) which asset, and the dates.
const listAssignments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.active === 'true') filter.returnedAt = null;
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.asset) filter.asset = req.query.asset;
  const assignments = await AssetAssignment.find(filter)
    .populate('asset', 'name assetTag category serialNumber')
    .populate('employee', USER_FIELDS)
    .sort({ assignedAt: -1, createdAt: -1 })
    .limit(2000);
  res.json({ count: assignments.length, assignments });
});

// ===== Employee self-service =====
const listMyAssets = asyncHandler(async (req, res) => {
  const assets = await Asset.find({ assignedTo: req.user._id }).sort({ assignedAt: -1 });
  res.json({ count: assets.length, assets });
});

module.exports = {
  listAssets, createAsset, updateAsset, deleteAsset, assignAsset, listAssignments, listMyAssets, ASSET_STATUS,
};
