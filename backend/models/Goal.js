const mongoose = require('mongoose');

// A performance goal/objective set for an employee for a review period, tracked
// with progress and an eventual rating. Part of the performance-management module.
// Draft -> not yet active; Active -> in progress; Completed -> achieved/closed; Cancelled -> dropped.
const GOAL_STATUS = ['Draft', 'Active', 'Completed', 'Cancelled'];

const goalSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    period: { type: String, trim: true }, // e.g. "Q1 2026", "FY2026"
    status: { type: String, enum: GOAL_STATUS, default: 'Active' },
    progress: { type: Number, min: 0, max: 100, default: 0 }, // percent complete
    rating: { type: Number, min: 0, max: 5, default: 0 }, // manager rating on completion (0-5)
    reviewNote: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog (labelled by title).
goalSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

module.exports = mongoose.model('Goal', goalSchema);
module.exports.GOAL_STATUS = GOAL_STATUS;
