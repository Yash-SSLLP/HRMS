const mongoose = require('mongoose');

// The leave module. Defines two models: LeaveRequest (an application that climbs
// a reporting-manager approval chain) and LeaveBalance (per-employee per-year
// quota/usage per leave type). Also exports the shared approval-step sub-schema
// reused by ExitRequest.

// Leave taxonomy. The stored value IS the full display name, so every screen
// that prints `leaveType` reads correctly without a lookup table.
//
//   Paid Leave      the ordinary ask. Paid while the employee's 2 days/month
//                   quota lasts; every day beyond it is automatically unpaid.
//   Unpaid Leave    explicitly unpaid — never touches the paid quota.
//   Emergency Leave granted the moment it is filed (no approval ladder); the
//                   whole reporting hierarchy + HR are informed instead. Pays
//                   exactly like Paid Leave. Repeat use in one month is flagged,
//                   and a manager/HR can then charge that day at double.
//   Maternity Leave the statutory 26-week entitlement — always paid, exempt from
//                   the monthly quota, drawn from the ML balance bucket.
const PAID_LEAVE = 'Paid Leave';
const UNPAID_LEAVE = 'Unpaid Leave';
const EMERGENCY_LEAVE = 'Emergency Leave';
const MATERNITY_LEAVE = 'Maternity Leave';
const LEAVE_TYPES = [PAID_LEAVE, UNPAID_LEAVE, EMERGENCY_LEAVE, MATERNITY_LEAVE];

// Retired short codes (EL/CL/SL/ML/PL/COMP/LOP). Kept in the enum ONLY so leave
// filed before this taxonomy stays valid when an old request is saved again —
// they are never offered for a new request.
const LEGACY_LEAVE_TYPES = ['EL', 'CL', 'SL', 'ML', 'PL', 'COMP', 'LOP'];

// Type predicates — always use these rather than comparing strings, so legacy
// records keep behaving the same as their modern equivalent.
const isUnpaidType = (t) => t === UNPAID_LEAVE || t === 'LOP';
const isMaternityType = (t) => t === MATERNITY_LEAVE || t === 'ML';
const isEmergencyType = (t) => t === EMERGENCY_LEAVE;

// Pending -> in approval chain; Approved/Rejected -> final decision; Cancelled -> withdrawn.
const LEAVE_STATUS = ['Pending', 'Approved', 'Rejected', 'Cancelled'];

// One rung of the leave approval ladder. A request climbs the chain: the
// applicant's manager, then that manager's manager, and finally HR, who has the
// last word on every leave request.
//
// CEO/MD are deliberately NOT rungs — the walk used to end on the first
// executive it reached, and now drops them into `execsToNotify` instead, so an
// executive hears the outcome rather than being asked to sign each request.
// See buildLeaveRouting in controllers/leaveController.js.
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
    leaveType: { type: String, enum: [...LEAVE_TYPES, ...LEGACY_LEAVE_TYPES], required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // Allow half-day requests (counted as 0.5)
    isHalfDay: { type: Boolean, default: false },
    halfDaySession: { type: String, enum: ['FirstHalf', 'SecondHalf'] },
    totalDays: { type: Number, required: true, min: 0.5 },
    // Split of the request's working days under the monthly paid-leave quota
    // (2 paid days/calendar month; anything beyond becomes Loss of Pay). Computed
    // at apply time (preview) and finalised at approval/stamp time. Excludes
    // Sundays + holidays, so paidDays + lopDays can be < totalDays.
    paidDays: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    // IST day keys ('YYYY-MM-DD') inside this request's range that the employee
    // actually WORKED, and which an approver has given back to them — see
    // releaseLeaveDay in leaveController. Such a day is excluded from the
    // paid/LOP split and is never re-stamped onto the attendance calendar.
    // `totalDays` deliberately still reports the span originally applied for;
    // this array is what says how much of it was handed back.
    workedDays: { type: [String], default: [] },
    reason: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: LEAVE_STATUS, default: 'Pending' },
    appliedAt: { type: Date, default: Date.now },
    // Whoever recorded the FINAL decision (last chain approver, or an HR override).
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionAt: Date,
    decisionNote: String,
    // Ordered reporting-hierarchy approval ladder built at apply time.
    approvalChain: [approvalStepSchema],
    // The CEO/MD who WOULD have been rungs on that ladder before leave stopped
    // asking executives to approve it. They are told the outcome once HR signs
    // off instead (buildLeaveRouting → notifyExecsFinalApproval).
    //
    // Stored rather than re-derived at notify time on purpose: the org chart can
    // change between filing and the final approval, and the person entitled to
    // hear how their report's leave ended is the one who was above them WHEN IT
    // WAS ASKED FOR.
    execsToNotify: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // The user whose turn it is right now (null once fully decided). Indexed so
    // an approver's inbox query (currentApprover === me) is cheap.
    currentApprover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    // ----- Emergency leave -----
    // Emergency leave is granted on filing, so instead of an approval ladder the
    // chain is recorded as "informed". Which emergency of the month this was
    // (1st, 2nd, …) drives the flag: from the 2nd onward the managers and HR are
    // told it is a repeat, and any of them can then charge the day at double.
    emergencyIndexInMonth: { type: Number, default: 0 },
    emergencyFlagged: { type: Boolean, default: false },
    // Double salary cut: the day costs 2× a day's pay in that month's payroll
    // (see the emergencyPenalty deduction). Reversible until the payslip is run.
    doubleCut: { type: Boolean, default: false },
    doubleCutBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    doubleCutByName: String,
    doubleCutAt: Date,
    doubleCutNote: { type: String, trim: true, maxlength: 500 },
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
module.exports = {
  LeaveRequest, LeaveBalance, LEAVE_STATUS, approvalStepSchema, CHAIN_STEP_STATUS,
  LEAVE_TYPES, LEGACY_LEAVE_TYPES,
  PAID_LEAVE, UNPAID_LEAVE, EMERGENCY_LEAVE, MATERNITY_LEAVE,
  isUnpaidType, isMaternityType, isEmergencyType,
};
