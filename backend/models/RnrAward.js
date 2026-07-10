const mongoose = require('mongoose');

// Monthly Rewards & Recognition (RNR). HR/Admin pick one "Employee of the Month"
// (org-wide) and one "Key Achiever" per department. The award stays a secret
// Draft until it is Announced, at which point every employee is notified and a
// celebratory banner shows on their dashboard for 2 working days.
const CATEGORIES = ['EmployeeOfMonth', 'KeyAchiever'];

// A single winner. Name / designation / photo are snapshotted at save time so the
// banner reflects who won even if the profile later changes.
const winnerSchema = new mongoose.Schema(
  {
    category: { type: String, enum: CATEGORIES, required: true },
    department: { type: String, trim: true, default: '' }, // set for KeyAchiever
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: String,
    designation: String,
    photo: { type: String, default: null }, // snapshot of user.photo → builds the avatar URL
    citation: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const rnrAwardSchema = new mongoose.Schema(
  {
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    winners: [winnerSchema],
    status: { type: String, enum: ['Draft', 'Announced'], default: 'Draft' },
    announcedAt: Date,
    // When the dashboard banner stops showing (announcedAt + 2 working days).
    bannerExpiresAt: Date,
    // Users who closed the banner — it stays hidden for them thereafter.
    dismissedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One award document per month.
rnrAwardSchema.index({ year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('RnrAward', rnrAwardSchema);
module.exports.CATEGORIES = CATEGORIES;
