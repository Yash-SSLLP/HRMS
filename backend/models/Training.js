const mongoose = require('mongoose');

// A training/L&D session or program with a set of participant employees.
// Part of the learning module (distinct from Course, which is the LMS e-learning).
// Planned -> scheduled; Ongoing -> in progress; Completed -> finished; Cancelled -> called off.
const TRAINING_STATUS = ['Planned', 'Ongoing', 'Completed', 'Cancelled'];

const trainingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    trainer: { type: String, trim: true },
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: TRAINING_STATUS, default: 'Planned' },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog (labelled by title).
trainingSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

module.exports = mongoose.model('Training', trainingSchema);
module.exports.TRAINING_STATUS = TRAINING_STATUS;
