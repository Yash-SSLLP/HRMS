const mongoose = require('mongoose');

// A compensatory-off request: an employee who worked a holiday/weekend earns a
// comp-off day, which must be approved and then availed before it expires.
// Pending -> awaiting review; Approved -> granted; Rejected -> denied; Availed -> comp-off taken.
const COMPOFF_STATUS = ['Pending', 'Approved', 'Rejected', 'Availed'];

const compOffSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    workedDate: { type: Date, required: true }, // the holiday/weekend worked
    reason: { type: String, required: true, trim: true },
    status: { type: String, enum: COMPOFF_STATUS, default: 'Pending', index: true },
    expiryDate: Date, // set on approval = workedDate + 90 days
    availedOn: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: String,
  },
  { timestamps: true }
);

// Audit-status plugin: logs every `status` transition to AuditLog with actor attribution.
compOffSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('CompOff', compOffSchema);
module.exports.COMPOFF_STATUS = COMPOFF_STATUS;
