const mongoose = require('mongoose');

// An organizational department (e.g. Engineering, HR). Referenced by users/profiles
// for grouping, org-chart structure and department-scoped reporting.
const departmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Department', departmentSchema);
