const mongoose = require('mongoose');

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

trainingSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

module.exports = mongoose.model('Training', trainingSchema);
module.exports.TRAINING_STATUS = TRAINING_STATUS;
