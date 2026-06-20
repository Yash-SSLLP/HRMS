const mongoose = require('mongoose');

const TASK_STATUS = ['Todo', 'InProgress', 'Review', 'Done'];
const TASK_PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    status: { type: String, enum: TASK_STATUS, default: 'Todo' },
    priority: { type: String, enum: TASK_PRIORITY, default: 'Medium' },
    dueDate: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

taskSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

module.exports = mongoose.model('Task', taskSchema);
module.exports.TASK_STATUS = TASK_STATUS;
module.exports.TASK_PRIORITY = TASK_PRIORITY;
