const mongoose = require('mongoose');

const rosterEntrySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', required: true },
    note: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

rosterEntrySchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('RosterEntry', rosterEntrySchema);
