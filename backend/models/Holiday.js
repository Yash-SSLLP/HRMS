const mongoose = require('mongoose');

// A single entry in the company holiday calendar (public/restricted/company holidays).
// Used to mark non-working days across attendance, payroll and leave calculations.

// Public = statutory holiday for all; Restricted = optional/floater; Company = org-specific day off.
const HOLIDAY_TYPES = ['Public', 'Restricted', 'Company'];

const holidaySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    date: { type: Date, required: true, index: true },
    type: { type: String, enum: HOLIDAY_TYPES, default: 'Public' },
    description: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Holiday', holidaySchema);
module.exports.HOLIDAY_TYPES = HOLIDAY_TYPES;
