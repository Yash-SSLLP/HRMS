const mongoose = require('mongoose');

// A locked-out user fills this in from the login page; HR/Admin then reset the
// account (via Users) and mark the request Resolved.
const PASSWORD_RESET_STATUSES = ['Open', 'Resolved'];

const passwordResetRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 160 },
    employeeCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    designation: { type: String, required: true, trim: true, maxlength: 120 },
    department: { type: String, required: true, trim: true, maxlength: 120 },
    reason: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: PASSWORD_RESET_STATUSES, default: 'Open', index: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
  },
  { timestamps: true }
);

passwordResetRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);
module.exports.PASSWORD_RESET_STATUSES = PASSWORD_RESET_STATUSES;
