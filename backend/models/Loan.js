const mongoose = require('mongoose');

// An employee loan / salary advance request. Once active, the EMI is recovered
// monthly and `balance` tracks the outstanding amount until the loan is closed.
const LOAN_TYPES = ['Salary Advance', 'Personal Loan', 'Emergency', 'Other'];
// Pending -> awaiting approval; Approved -> sanctioned; Active -> disbursed & recovering; Closed -> fully repaid; Rejected -> denied.
const LOAN_STATUS = ['Pending', 'Approved', 'Active', 'Closed', 'Rejected'];

const loanSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: LOAN_TYPES, default: 'Salary Advance' },
    principal: { type: Number, required: true, min: 0 },
    emi: { type: Number, default: 0, min: 0 }, // monthly recovery
    tenureMonths: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: 0, min: 0 }, // outstanding amount still to be recovered
    status: { type: String, enum: LOAN_STATUS, default: 'Pending', index: true },
    reason: { type: String, trim: true },
    disbursedOn: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewNote: { type: String },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
loanSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Loan', loanSchema);
module.exports.LOAN_TYPES = LOAN_TYPES;
module.exports.LOAN_STATUS = LOAN_STATUS;
