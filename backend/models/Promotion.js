const mongoose = require('mongoose');

/**
 * One promotion (or department move) given to an employee — the history row
 * behind the Promotions page. The change itself lives on EmployeeProfile
 * (designation / department); this row is the record of what it was before,
 * what it became, from when, and who did it.
 */
const promotionSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    previousDesignation: { type: String, trim: true, default: '' },
    newDesignation: { type: String, trim: true, default: '' },
    previousDepartment: { type: String, trim: true, default: '' },
    newDepartment: { type: String, trim: true, default: '' },
    effectiveDate: { type: Date, required: true },
    remarks: { type: String, trim: true, maxlength: 500 },
    promotedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    promotedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

promotionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Promotion', promotionSchema);
