const mongoose = require('mongoose');

// A monthly payslip for one employee: earnings, statutory deductions and
// employer contributions (Indian payroll), with computed gross/net. One per
// employee per month; drives salary disbursement and the shareable payslip PDF.

// Indian salary components (earnings)
const earningsSchema = new mongoose.Schema(
  {
    basic: { type: Number, default: 0, min: 0 },
    hra: { type: Number, default: 0, min: 0 },           // House Rent Allowance
    specialAllowance: { type: Number, default: 0, min: 0 },
    conveyanceAllowance: { type: Number, default: 0, min: 0 },
    medicalAllowance: { type: Number, default: 0, min: 0 },
    lta: { type: Number, default: 0, min: 0 },           // Leave Travel Allowance
    bonus: { type: Number, default: 0, min: 0 },
    overtime: { type: Number, default: 0, min: 0 },
    // Unused portion of the monthly paid-leave quota (max 2 days), converted to
    // extra pay at one day's salary each. Settled every month — never carried forward.
    leaveIncentive: { type: Number, default: 0, min: 0 },
    // Working a Sunday or an org-wide comp-off day pays double. The day is
    // already paid once inside the monthly salary, so this line is the ONE extra
    // day's pay that doubles it — and only for days HR or the reporting manager
    // approved (see utils/restDay.js).
    doubleDayPay: { type: Number, default: 0, min: 0 },
    otherEarnings: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Statutory + other deductions (Indian payroll)
const deductionsSchema = new mongoose.Schema(
  {
    epf: { type: Number, default: 0, min: 0 },                  // Employee PF (typ. 12% of Basic)
    esic: { type: Number, default: 0, min: 0 },                 // ESIC (0.75% of gross, if gross <= 21k)
    professionalTax: { type: Number, default: 0, min: 0 },      // State-specific (e.g. Maharashtra: 200/mo)
    tds: { type: Number, default: 0, min: 0 },                  // Income tax deducted at source
    loanRecovery: { type: Number, default: 0, min: 0 },         // EMI on loans other than a salary advance
    // EMI on 'Salary Advance' loans, kept apart from loanRecovery because the
    // salary slip prints LOAN and Salary In Advance as two separate lines.
    salaryAdvance: { type: Number, default: 0, min: 0 },
    // Pay recovered for days not worked. Earnings are ALWAYS the full monthly
    // value (Basic is never prorated) — every unpaid day, whether LOP or a day
    // before joining / after exit, is charged back here at one day's salary.
    lopDeduction: { type: Number, default: 0, min: 0 },
    // Penalty for late arrivals beyond the 5/month allowance. ₹200/day when the
    // employee's monthly Basic < ₹25,000, else ₹400/day.
    latePenalty: { type: Number, default: 0, min: 0 },
    // Emergency leave a manager/HR chose to charge at DOUBLE pay. Emergency
    // leave needs no approval, so this is the after-the-fact control on misuse:
    // the day ends up costing two days' salary in total. This line is whatever
    // is owed on top of what the day already cost through paid/LOP days.
    emergencyPenalty: { type: Number, default: 0, min: 0 },
    otherDeductions: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Employer-side contributions (not deducted from employee, tracked for compliance)
const employerContributionsSchema = new mongoose.Schema(
  {
    epf: { type: Number, default: 0, min: 0 },     // Employer PF share (3.67% to EPF + 8.33% to EPS)
    eps: { type: Number, default: 0, min: 0 },     // Employee Pension Scheme portion
    esic: { type: Number, default: 0, min: 0 },    // Employer ESIC share (3.25% of gross)
    gratuity: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Release workflow. A payslip is HR's document until they hand it over: the
// employee asks for it, HR approves the request, corrects the slip if needed,
// previews it, and only on finalising can the employee download it. The employee
// may then ask for a correction, which sends it back to HR.
//
//   NotRequested → Requested → Approved → Finalised ⇄ ChangeRequested
//
// Kept apart from `status` on purpose: `status` tracks the money (is it approved
// for payment, has it been paid), this tracks custody of the document. A slip can
// be Paid but not yet released, and vice versa.
const RELEASE_STATES = ['NotRequested', 'Requested', 'Approved', 'Finalised', 'ChangeRequested'];

const releaseSchema = new mongoose.Schema(
  {
    status: { type: String, enum: RELEASE_STATES, default: 'NotRequested', index: true },
    requestedAt: Date,
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    finalisedAt: Date,
    finalisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // What the employee says is wrong, when they ask for a correction.
    changeNote: { type: String, trim: true },
    // Every transition, so a disputed payslip has a readable trail.
    history: [
      {
        _id: false,
        action: String,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byName: String,
        note: String,
      },
    ],
  },
  { _id: false }
);

const payrollSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
      index: true,
    },
    // Indian payroll cycles are monthly; track the salary month
    payPeriodMonth: { type: Number, required: true, min: 1, max: 12 },
    payPeriodYear: { type: Number, required: true },

    workingDays: { type: Number, default: 0, min: 0 },
    paidDays: { type: Number, default: 0, min: 0 },
    lopDays: { type: Number, default: 0, min: 0 }, // Loss of Pay
    // Day counts printed on the salary slip alongside the three above.
    halfDays: { type: Number, default: 0, min: 0 },
    lateDays: { type: Number, default: 0, min: 0 },            // check-ins past the late cut-off
    additionalPaidDays: { type: Number, default: 0, min: 0 },  // unused paid-leave quota, paid out

    // Salary in force for THIS pay month, frozen onto the payslip. CTC is
    // resolved per month from the employee's hike history, so a slip reprinted
    // after a hike must not pick up the new figure.
    monthlySalary: { type: Number, default: 0, min: 0 },
    annualCtc: { type: Number, default: 0, min: 0 },

    earnings: { type: earningsSchema, default: () => ({}) },
    deductions: { type: deductionsSchema, default: () => ({}) },
    employerContributions: { type: employerContributionsSchema, default: () => ({}) },

    grossSalary: { type: Number, default: 0 },     // Sum of earnings
    totalDeductions: { type: Number, default: 0 }, // Sum of deductions
    netPay: { type: Number, default: 0 },          // grossSalary - totalDeductions

    // Draft -> being prepared; Approved -> signed off; Paid -> disbursed; OnHold -> payment withheld.
    status: {
      type: String,
      // 'Void' is a CANCELLED payslip that is deliberately still here. A paid
      // month cannot be deleted: this row is what every "never overwrite a Paid
      // payslip" guard in the payroll run reads, so removing it would let the
      // month be generated and disbursed a second time — and it is what the
      // year's YTD, the Form 16 basis and the statutory returns are summed from.
      // Voiding keeps the slot and the history and hides the slip everywhere it
      // would otherwise be counted or read.
      enum: ['Draft', 'Approved', 'Paid', 'OnHold', 'Void'],
      default: 'Draft',
    },
    paymentDate: Date,
    paymentReference: String,
    remarks: String,

    // Shareable public link: a random token lets the employee open this payslip's
    // PDF without logging in (generated on demand when HR shares it).
    publicToken: { type: String, index: true },
    emailedAt: { type: Date },

    // Release to the employee — separate from `status`, which is about the money
    // (Draft/Approved/Paid). This is about who may hold the document.
    release: { type: releaseSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// Cancelling a payslip after payment. `status` becomes 'Void'; this records who
// did it, when, and why — the row itself is never removed (see the status enum).
payrollSchema.add({
  voided: {
    at: Date,
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, trim: true, maxlength: 500 },
    // What the slip said when it was voided, so the figures survive a later edit.
    netPayAtVoid: Number,
    statusAtVoid: String,
  },
});

// One payslip per employee per month
payrollSchema.index(
  { employee: 1, payPeriodYear: 1, payPeriodMonth: 1 },
  { unique: true }
);

// The component keys, read off the schemas rather than hand-listed. Adding a
// field to either sub-schema above now folds it into the totals automatically —
// `doubleDayPay` was once missed from the hand-written gross sum, which left the
// printed rows on a payslip not adding up to the printed total.
const EARNING_KEYS = Object.keys(earningsSchema.paths);
const DEDUCTION_KEYS = Object.keys(deductionsSchema.paths);

const sumOf = (doc, keys) => keys.reduce((total, k) => total + (Number(doc?.[k]) || 0), 0);

// Auto-compute gross / deductions / net before save
payrollSchema.pre('save', function computeTotals(next) {
  this.grossSalary = sumOf(this.earnings, EARNING_KEYS);
  this.totalDeductions = sumOf(this.deductions, DEDUCTION_KEYS);
  this.netPay = this.grossSalary - this.totalDeductions;
  next();
});

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
payrollSchema.plugin(require("./plugins/auditStatus"));

const Payroll = mongoose.model('Payroll', payrollSchema);
Payroll.RELEASE_STATES = RELEASE_STATES;

module.exports = Payroll;
