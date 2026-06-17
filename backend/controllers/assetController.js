const asyncHandler = require('express-async-handler');
const Asset = require('../models/Asset');
const { ASSET_STATUS } = require('../models/Asset');

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
  await asset.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// PATCH /api/assets/:id/assign  { userId }  |  PATCH /api/assets/:id/return
const assignAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  const { userId } = req.body;
  if (userId) {
    asset.assignedTo = userId;
    asset.assignedAt = new Date();
    asset.status = 'Assigned';
  } else {
    asset.assignedTo = undefined;
    asset.assignedAt = undefined;
    asset.status = 'Available';
  }
  await asset.save();
  res.json({ asset });
});

// ===== Employee self-service =====
const listMyAssets = asyncHandler(async (req, res) => {
  const assets = await Asset.find({ assignedTo: req.user._id }).sort({ assignedAt: -1 });
  res.json({ count: assets.length, assets });
});

module.exports = {
  listAssets, createAsset, updateAsset, deleteAsset, assignAsset, listMyAssets, ASSET_STATUS,
};
