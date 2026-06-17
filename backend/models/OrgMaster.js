const mongoose = require('mongoose');

const ORG_MASTER_KINDS = ['Designation', 'Grade', 'Location'];

const orgMasterSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ORG_MASTER_KINDS, required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, uppercase: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

orgMasterSchema.index({ kind: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('OrgMaster', orgMasterSchema);
module.exports.ORG_MASTER_KINDS = ORG_MASTER_KINDS;
