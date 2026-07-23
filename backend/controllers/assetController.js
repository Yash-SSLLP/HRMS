/**
 * Asset controller — company asset inventory (Asset) plus an allocation history
 * (AssetAssignment). HR/Admin do asset CRUD and assign/return assets to employees,
 * keeping a full holding history; employees list assets currently allotted to them.
 */
const asyncHandler = require('express-async-handler');
const Asset = require('../models/Asset');
const { ASSET_STATUS } = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');

const USER_FIELDS = 'firstName lastName email role';

// ===== HR/Admin =====
/**
 * List assets with optional status/category filters, newest first.
 * @route GET /api/assets  (HR/Admin)
 * @param {string} [req.query.status]
 * @param {string} [req.query.category]
 * @returns {{count: number, assets: Object[]}} with populated assignedTo
 */
const listAssets = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const assets = await Asset.find(filter)
    .populate('assignedTo', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: assets.length, assets });
});

/**
 * Create an asset (unique assetTag, compared case-insensitively).
 * @route POST /api/assets  (HR/Admin)
 * @param {string} req.body.name - required
 * @param {string} req.body.assetTag - required, unique
 * @returns {{asset: Object}} (201); 409 if tag exists
 */
const createAsset = asyncHandler(async (req, res) => {
  const { name, assetTag } = req.body;
  if (!name || !assetTag) {
    res.status(400);
    throw new Error('name and assetTag are required');
  }
  // Enforce unique tag (normalized to upper case)
  const exists = await Asset.findOne({ assetTag: assetTag.toUpperCase() });
  if (exists) {
    res.status(409);
    throw new Error('An asset with that tag already exists');
  }
  const asset = await Asset.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ asset });
});

/**
 * Update an asset (partial).
 * @route PUT /api/assets/:id  (HR/Admin)
 * @param {string} req.params.id - asset id
 * @param {Object} req.body - fields to update
 * @returns {{asset: Object}}
 */
const updateAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(asset, req.body);
  await asset.save();
  res.json({ asset });
});

/**
 * Delete an asset and its whole assignment history.
 * @route DELETE /api/assets/:id  (HR/Admin)
 * @param {string} req.params.id - asset id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  // Cascade: remove the asset's allocation history first
  await AssetAssignment.deleteMany({ asset: asset._id });
  await asset.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Assign an asset to an employee, or return it to stock, maintaining history.
 * @route PATCH /api/assets/:id/assign  (HR/Admin)
 * @param {string} req.params.id - asset id
 * @param {string|null} req.body.userId - employee to give it to; null/'' returns it
 * @param {string} [req.body.date] - assignment/return date (defaults to now)
 * @param {string} [req.body.note] - truncated to 500 chars
 * @returns {{asset: Object}} with updated assignedTo/status
 * @sideeffect closes any open AssetAssignment; opens a new one when assigning
 */
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

/**
 * The allocation register: assignment records with optional filters (max 2000).
 * @route GET /api/assets/assignments  (HR/Admin)
 * @param {string} [req.query.active] - 'true' for currently-held (not returned)
 * @param {string} [req.query.employee]
 * @param {string} [req.query.asset]
 * @returns {{count: number, assignments: Object[]}} with populated asset/employee
 */
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
/**
 * List assets currently assigned to the caller.
 * @route GET /api/assets/me
 * @returns {{count: number, assets: Object[]}}
 */
const listMyAssets = asyncHandler(async (req, res) => {
  const assets = await Asset.find({ assignedTo: req.user._id }).sort({ assignedAt: -1 });
  res.json({ count: assets.length, assets });
});

module.exports = {
  listAssets, createAsset, updateAsset, deleteAsset, assignAsset, listAssignments, listMyAssets, ASSET_STATUS,
};
