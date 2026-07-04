const mongoose = require('mongoose');

const REGULARIZATION_TYPES = [
  'Missing Punch',
  'Wrong Time',
  'Forgot Check-in',
  'Forgot Check-out',
  'On Duty',
  'Other',
];
const REGULARIZATION_STATUS = ['Pending', 'Approved', 'Rejected'];

const regularizationSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    type: { type: String, enum: REGULARIZATION_TYPES, default: 'Other' },
    requestedCheckIn: { type: String },
    requestedCheckOut: { type: String },
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
  },
  { timestamps: true }
);

regularizationSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Regularization', regularizationSchema);
module.exports.REGULARIZATION_TYPES = REGULARIZATION_TYPES;
module.exports.REGULARIZATION_STATUS = REGULARIZATION_STATUS;
