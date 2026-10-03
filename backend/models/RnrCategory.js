const mongoose = require('mongoose');

/**
 * A Rewards & Recognition award category (2026-10-03, user: "Give HR and Admin
 * to create what are the categories of these awards — they can add and delete
 * them. 'Best Employee' will be there also in the top").
 *
 * `key` is what a winner row stores (RnrAward.winners[].category). The two keys
 * the app shipped with keep their meaning so existing awards, banners and older
 * app builds still read: `EmployeeOfMonth` is the top award, now named
 * "Best Employee", and is `locked` (cannot be deleted or renamed);
 * `KeyAchiever` is an ordinary, deletable category with one winner per
 * department. A category HR adds gets a generated key.
 */
const rnrCategorySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // One winner per department (true) or one winner company-wide (false).
    perDepartment: { type: Boolean, default: false },
    // The top award: always first, never deleted or renamed.
    locked: { type: Boolean, default: false },
    order: { type: Number, default: 100 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RnrCategory', rnrCategorySchema);
