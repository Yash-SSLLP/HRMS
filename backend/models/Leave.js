const mongoose = require('mongoose');

// The leave module. Defines two models: LeaveRequest (an application that climbs
// a reporting-manager approval chain) and LeaveBalance (per-employee per-year
// quota/usage per leave type). Also exports the shared approval-step sub-schema
// reused by ExitRequest.

// Indian leave taxonomy
// EL  = Earned / Privilege Leave (accrued, encashable)
// CL  = Casual Leave
// SL  = Sick Leave
// ML  = Maternity Leave (Maternity Benefit Act, 1961 — 26 weeks)
// PL  = Paternity Leave (policy-driven; no central statute)
// COMP = Compensatory Off
// LOP = Loss of Pay (unpaid)
const LEAVE_TYPES = ['EL', 'CL', 'SL', 'ML', 'PL', 'COMP', 'LOP'];

// Pending -> in approval chain; Approved/Rejected -> final decision; Cancelled -> withdrawn.
const LEAVE_STATUS = ['Pending', 'Approved', 'Rejected', 'Cancelled'];

// One rung of the reporting-hierarchy approval ladder. A request climbs the
// chain: the applicant's manager, then that manager's manager, … up to the first
// CEO/MD, who gives final approval. HR is informed only (not a rung).
const CHAIN_STEP_STATUS = ['Waiting', 'Pending', 'Approved', 'Rejected', 'Skipped'];
const approvalStepSchema = new mongoose.Schema(
  {
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approverName: String,
    role: String,
    order: { type: Number, default: 0 },
    // Waiting = not yet their turn; Pending = awaiting this person's decision;
    // Approved/Rejected = decided; Skipped = a lower rung rejected, or an HR
    // override short-circuited the chain.
    status: { type: String, enum: CHAIN_STEP_STATUS, default: 'Waiting' },
    decidedAt: Date,
    note: String,
  },
  { _id: true }
);

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
    // Whoever recorded the FINAL decision (last chain approver, or an HR override).
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionAt: Date,
    decisionNote: String,
    // Ordered reporting-hierarchy approval ladder built at apply time.
    approvalChain: [approvalStepSchema],
    // The user whose turn it is right now (null once fully decided). Indexed so
    // an approver's inbox query (currentApprover === me) is cheap.
    currentApprover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
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

// One balance document per employee per year.
leaveBalanceSchema.index({ employee: 1, year: 1 }, { unique: true });

// Audit-status plugin: logs LeaveRequest `status` transitions to AuditLog.
leaveRequestSchema.plugin(require("./plugins/auditStatus"));
const LeaveRequest = mongoose.model('LeaveRequest', leaveRequestSchema);
const LeaveBalance = mongoose.model('LeaveBalance', leaveBalanceSchema);

// The reporting-hierarchy rung shape is reused by other models that climb the
// same approval ladder (e.g. ExitRequest). Exported so they share one definition.
module.exports = { LeaveRequest, LeaveBalance, LEAVE_TYPES, LEAVE_STATUS, approvalStepSchema, CHAIN_STEP_STATUS };
