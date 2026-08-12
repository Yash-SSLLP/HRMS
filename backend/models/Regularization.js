const mongoose = require('mongoose');
const { approvalStepSchema } = require('./Leave'); // reuse the shared approval-chain rung schema

// An attendance-correction request: an employee asks HR to fix a day's punch
// (missing/incorrect check-in or -out). On approval it is applied to the
// Attendance record, and the before/after values are stored here for audit.
const REGULARIZATION_TYPES = [
  'Missing Punch',
  'Wrong Time',
  'Forgot Check-in',
  'Forgot Check-out',
  'On Duty',
  'Other',
];
// Pending -> awaiting HR review; Approved -> applied to attendance; Rejected -> denied.
const REGULARIZATION_STATUS = ['Pending', 'Approved', 'Rejected'];

const regularizationSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    type: { type: String, enum: REGULARIZATION_TYPES, default: 'Other' },
    requestedCheckIn: { type: String }, // corrected check-in time the employee is asking for
    requestedCheckOut: { type: String }, // corrected check-out time the employee is asking for
    reason: { type: String, required: true, trim: true },
    status: { type: String, enum: REGULARIZATION_STATUS, default: 'Pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
    // Audit trail of what actually changed on the attendance record when this
    // regularization was applied — the "from → to". Filled by applyToAttendance
    // so SuperAdmin/CEO can see exactly what HR changed and when.
    previousStatus: { type: String },
    previousCheckIn: { type: Date },
    previousCheckOut: { type: Date },
    appliedCheckIn: { type: Date },
    appliedCheckOut: { type: Date },

    // Configured approval ladder (EmployeeProfile.regularizationApprovers): 1 or
    // 2 rungs, same rung shape as leave/exit so the inbox logic is shared. An
    // EMPTY chain is meaningful — it means no approvers were configured for this
    // employee, so the request stays on the flat "any HR reviewer" path.
    approvalChain: [approvalStepSchema],
    // Whose turn it is right now; null once decided (or when there is no chain).
    currentApprover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
regularizationSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Regularization', regularizationSchema);
module.exports.REGULARIZATION_TYPES = REGULARIZATION_TYPES;
module.exports.REGULARIZATION_STATUS = REGULARIZATION_STATUS;
