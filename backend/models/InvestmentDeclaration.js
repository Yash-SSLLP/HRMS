const mongoose = require('mongoose');

// An employee's annual tax investment/deduction declaration for a financial year,
// used for TDS/income-tax computation in payroll. One per employee per FY.
const REGIMES = ['Old', 'New']; // Indian income-tax regime chosen for the year
// Draft -> employee editing; Submitted -> sent for HR review; Verified -> proofs accepted; Rejected -> sent back.
const DECLARATION_STATUSES = ['Draft', 'Submitted', 'Verified', 'Rejected'];

const num = { type: Number, default: 0, min: 0 };

const investmentDeclarationSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    financialYear: { type: String, required: true }, // e.g. '2025-26'
    regime: { type: String, enum: REGIMES, default: 'Old' },
    sections: {
      section80C: num, // PF / ELSS / LIC etc.
      section80CCD1B: num, // NPS
      section80D: num, // medical insurance
      section24B: num, // home loan interest
      section80E: num, // education loan
      section80G: num, // donations
      hraAnnualRent: num,
      ltaClaimed: num,
      otherDeductions: num,
    },
    proofs: [
      {
        label: { type: String, trim: true },
        url: { type: String, trim: true },
      },
    ],
    status: { type: String, enum: DECLARATION_STATUSES, default: 'Draft', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true },
  },
  { timestamps: true }
);

// One declaration per employee per financial year.
investmentDeclarationSchema.index({ employee: 1, financialYear: 1 }, { unique: true });

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
investmentDeclarationSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('InvestmentDeclaration', investmentDeclarationSchema);
module.exports.REGIMES = REGIMES;
module.exports.DECLARATION_STATUSES = DECLARATION_STATUSES;
