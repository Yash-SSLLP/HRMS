const mongoose = require('mongoose');

// Shared lookup/master-data table backing several org dropdowns in one collection,
// discriminated by `kind`. Provides the option lists for designation, grade and location.
const ORG_MASTER_KINDS = ['Designation', 'Grade', 'Location'];

const orgMasterSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ORG_MASTER_KINDS, required: true, index: true }, // which master list this row belongs to
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, uppercase: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Names must be unique within a given kind (no duplicate designations, etc.).
orgMasterSchema.index({ kind: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('OrgMaster', orgMasterSchema);
module.exports.ORG_MASTER_KINDS = ORG_MASTER_KINDS;
