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

    // ----- The Advance Request Form (config/loanForm.js) -----
    // "Purpose of Advance", chosen from the list HR keeps (Setting.loanForm).
    // The WORDS are stored, not a reference, so trimming the list later never
    // changes what an old request says it was for. An employee's request also
    // copies it into `reason`, which older screens still read.
    purpose: { type: String, trim: true },
    // "Request Date of disbursement" — the day the employee asked to be paid.
    // An IST calendar day as 'YYYY-MM-DD' rather than a Date, for the same
    // reason recoveryStart* is a pair of numbers: there is no timezone to slip
    // it onto the day before. (disbursedOn is when it was actually paid.)
    requestedDisbursementOn: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    // The form's Employee Details, as they stood when it was filled in. A form
    // is a record: a later promotion must not rewrite the one already signed.
    // Absent on loans older than the form — the PDF reads the profile then.
    applicant: {
      type: new mongoose.Schema({
        name: { type: String, trim: true },
        employeeCode: { type: String, trim: true },
        designation: { type: String, trim: true },
        department: { type: String, trim: true },
      }, { _id: false }),
      default: undefined,
    },
    // The terms the employee ticked, word for word, and when. Present only when
    // the employee filed the form themselves — a loan HR opened on somebody's
    // behalf was never accepted online, so its PDF leaves the declaration for
    // a signature on paper.
    acceptance: {
      type: new mongoose.Schema({
        acceptedAt: { type: Date, required: true },
        terms: { type: [String], default: [] },
        declaration: { type: String },
      }, { _id: false }),
      default: undefined,
    },
    disbursedOn: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewNote: { type: String },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
// `person` names the row after the person it is about: who is borrowing.
// Without it the audit screen has only an id fragment to show, because this
// record has no name or title of its own. See plugins/auditStatus.js.
loanSchema.plugin(require("./plugins/auditStatus"), { person: "employee" });

module.exports = mongoose.model('Loan', loanSchema);
module.exports.LOAN_TYPES = LOAN_TYPES;
module.exports.LOAN_STATUS = LOAN_STATUS;
