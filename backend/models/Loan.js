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
    // WHEN the recovery starts, as a plain (year, month) pair rather than a
    // Date: payroll runs for a calendar month and compares month numbers, and a
    // Date pinned to the 1st is one timezone conversion away from landing in the
    // previous month (the trap utils/istDate exists for). Both the employee
    // asking and HR approving set these; 0/absent means "as soon as it is
    // approved", which is how every loan behaved before this existed.
    recoveryStartYear: { type: Number, default: 0, min: 0 },
    recoveryStartMonth: { type: Number, default: 0, min: 0, max: 12 },
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
