const mongoose = require('mongoose');

const JOB_STATUS = ['Open', 'OnHold', 'Closed'];

const jobSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    department: { type: String, trim: true },
    location: { type: String, trim: true },
    employmentType: {
      type: String,
      enum: ['FullTime', 'PartTime', 'Contract', 'Intern'],
      default: 'FullTime',
    },
    openings: { type: Number, default: 1, min: 0 },
    description: { type: String, trim: true },
    status: { type: String, enum: JOB_STATUS, default: 'Open' },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

jobSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

module.exports = mongoose.model('Job', jobSchema);
module.exports.JOB_STATUS = JOB_STATUS;
