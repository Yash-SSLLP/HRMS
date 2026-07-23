const mongoose = require('mongoose');

// A named work shift (e.g. General, Night) with start/end times. Assigned to
// employees per day via RosterEntry and used by attendance/scheduling.
const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, uppercase: true },
    startTime: { type: String }, // e.g. '09:00'
    endTime: { type: String }, // e.g. '18:00'
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Shift', shiftSchema);
