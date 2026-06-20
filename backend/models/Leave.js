const mongoose = require('mongoose');

// Indian leave taxonomy
// EL  = Earned / Privilege Leave (accrued, encashable)
// CL  = Casual Leave
// SL  = Sick Leave
// ML  = Maternity Leave (Maternity Benefit Act, 1961 — 26 weeks)
// PL  = Paternity Leave (policy-driven; no central statute)
// COMP = Compensatory Off
// LOP = Loss of Pay (unpaid)
const LEAVE_TYPES = ['EL', 'CL', 'SL', 'ML', 'PL', 'COMP', 'LOP'];

const LEAVE_STATUS = ['Pending', 'Approved', 'Rejected', 'Cancelled'];

const leaveRequestSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
      index: true,
    },
    leaveType: { type: String, enum: LEAVE_TYPES, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // Allow half-day requests (counted as 0.5)
    isHalfDay: { type: Boolean, default: false },
    halfDaySession: { type: String, enum: ['FirstHalf', 'SecondHalf'] },
    totalDays: { type: Number, required: true, min: 0.5 },
    reason: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: LEAVE_STATUS, default: 'Pending' },
    appliedAt: { type: Date, default: Date.now },
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionAt: Date,
    decisionNote: String,
  },
  { timestamps: true }
);

// Per-employee per-year leave balance, one document covers all types
const leaveBalanceSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
    },
    year: { type: Number, required: true }, // calendar year (India: Jan–Dec is most common)

    // Each bucket: opening (carry-forward + grant), used, balance
    balances: {
      EL: {
        opening: { type: Number, default: 0 },
        granted: { type: Number, default: 0 }, // accrual during the year
        used: { type: Number, default: 0 },
        encashed: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
      },
      CL: {
        opening: { type: Number, default: 0 },
        granted: { type: Number, default: 0 },
        used: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
      },
      SL: {
        opening: { type: Number, default: 0 },
        granted: { type: Number, default: 0 },
        used: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
      },
      ML: {
        // 26 weeks per Maternity Benefit (Amendment) Act, 2017
        granted: { type: Number, default: 182 },
        used: { type: Number, default: 0 },
        balance: { type: Number, default: 182 },
      },
    },
  },
  { timestamps: true }
);

leaveBalanceSchema.index({ employee: 1, year: 1 }, { unique: true });

leaveRequestSchema.plugin(require("./plugins/auditStatus"));
const LeaveRequest = mongoose.model('LeaveRequest', leaveRequestSchema);
const LeaveBalance = mongoose.model('LeaveBalance', leaveBalanceSchema);

module.exports = { LeaveRequest, LeaveBalance, LEAVE_TYPES, LEAVE_STATUS };
