const mongoose = require('mongoose');

// One employee's shift assignment for a single day (the duty roster).
// Links an employee to a Shift on a date; one row per employee per day.
const rosterEntrySchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', required: true }, // assigned Shift for this day
    note: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One roster entry per employee per date (no double-booking a day).
rosterEntrySchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('RosterEntry', rosterEntrySchema);
