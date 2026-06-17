const mongoose = require('mongoose');

const ASSET_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Phone', 'SIM', 'Furniture', 'Vehicle', 'Other'];
const ASSET_STATUS = ['Available', 'Assigned', 'InRepair', 'Retired'];

const assetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    assetTag: { type: String, required: true, unique: true, trim: true, uppercase: true },
    category: { type: String, enum: ASSET_CATEGORIES, default: 'Other' },
    serialNumber: { type: String, trim: true },
    status: { type: String, enum: ASSET_STATUS, default: 'Available' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignedAt: Date,
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Asset', assetSchema);
module.exports.ASSET_CATEGORIES = ASSET_CATEGORIES;
module.exports.ASSET_STATUS = ASSET_STATUS;
