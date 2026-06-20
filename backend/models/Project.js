const mongoose = require('mongoose');

const PROJECT_STATUS = ['Planning', 'Active', 'OnHold', 'Completed', 'Cancelled'];

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    status: { type: String, enum: PROJECT_STATUS, default: 'Planning' },
    startDate: Date,
    endDate: Date,
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

projectSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.name });

module.exports = mongoose.model('Project', projectSchema);
module.exports.PROJECT_STATUS = PROJECT_STATUS;
