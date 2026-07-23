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
    loanRecovery: { type: Number, default: 0, min: 0 },
    // Penalty for late arrivals beyond the 5/month allowance. ₹200/day when the
    // employee's monthly Basic < ₹25,000, else ₹400/day.
    latePenalty: { type: Number, default: 0, min: 0 },
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

    earnings: { type: earningsSchema, default: () => ({}) },
    deductions: { type: deductionsSchema, default: () => ({}) },
    employerContributions: { type: employerContributionsSchema, default: () => ({}) },

    grossSalary: { type: Number, default: 0 },     // Sum of earnings
    totalDeductions: { type: Number, default: 0 }, // Sum of deductions
    netPay: { type: Number, default: 0 },          // grossSalary - totalDeductions

    // Draft -> being prepared; Approved -> signed off; Paid -> disbursed; OnHold -> payment withheld.
    status: {
      type: String,
      enum: ['Draft', 'Approved', 'Paid', 'OnHold'],
      default: 'Draft',
    },
    paymentDate: Date,
    paymentReference: String,
    remarks: String,

    // Shareable public link: a random token lets the employee open this payslip's
    // PDF without logging in (generated on demand when HR shares it).
    publicToken: { type: String, index: true },
    emailedAt: { type: Date },
  },
  { timestamps: true }
);

// One payslip per employee per month
payrollSchema.index(
  { employee: 1, payPeriodYear: 1, payPeriodMonth: 1 },
  { unique: true }
);

// Auto-compute gross / deductions / net before save
payrollSchema.pre('save', function computeTotals(next) {
  const e = this.earnings || {};
  const d = this.deductions || {};

  this.grossSalary =
    (e.basic || 0) +
    (e.hra || 0) +
    (e.specialAllowance || 0) +
    (e.conveyanceAllowance || 0) +
    (e.medicalAllowance || 0) +
    (e.lta || 0) +
    (e.bonus || 0) +
    (e.overtime || 0) +
    (e.leaveIncentive || 0) +
    (e.otherEarnings || 0);

  this.totalDeductions =
    (d.epf || 0) +
    (d.esic || 0) +
    (d.professionalTax || 0) +
    (d.tds || 0) +
    (d.loanRecovery || 0) +
    (d.latePenalty || 0) +
    (d.otherDeductions || 0);

  this.netPay = this.grossSalary - this.totalDeductions;
  next();
});

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
payrollSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Payroll', payrollSchema);
