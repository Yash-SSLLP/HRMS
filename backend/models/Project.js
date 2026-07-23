const mongoose = require('mongoose');

// A project in the task/project-tracking module. Groups Tasks under a manager
// and a set of member employees.
// Planning -> being set up; Active -> in execution; OnHold -> paused; Completed -> finished; Cancelled -> dropped.
const PROJECT_STATUS = ['Planning', 'Active', 'OnHold', 'Completed', 'Cancelled'];

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    status: { type: String, enum: PROJECT_STATUS, default: 'Planning' },
    startDate: Date,
    endDate: Date,
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // project lead
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // employees on the project team
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog (labelled by name).
projectSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.name });

module.exports = mongoose.model('Project', projectSchema);
module.exports.PROJECT_STATUS = PROJECT_STATUS;
