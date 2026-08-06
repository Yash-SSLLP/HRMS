const mongoose = require('mongoose');

// A single entry in the company holiday calendar (public/restricted/company holidays).
// Used to mark non-working days across attendance, payroll and leave calculations.

// Public = statutory holiday for all; Restricted = optional/floater; Company = org-specific day off.
// Comp Off = an org-wide compensatory day off (e.g. the office closes on a Friday
// because everyone worked the Saturday before). It behaves like any other holiday
// everywhere — non-working, not LOP — with one difference: an employee who ACTUALLY
// works a Comp Off day (or a Sunday) can be paid double for it, once HR or their
// manager approves the day. See utils/restDay.js.
const COMP_OFF = 'Comp Off';
const HOLIDAY_TYPES = ['Public', 'Restricted', 'Company', COMP_OFF];

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
module.exports.COMP_OFF = COMP_OFF;
