const mongoose = require('mongoose');

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
