const mongoose = require('mongoose');

/**
 * Atomic named counters, used to mint the human-quotable reference codes that
 * appear on vouchers and reimbursements (see services/sequence.js).
 *
 * A code has to be unique and gap-tolerant but must NOT be derived by scanning
 * the collection for the current maximum: two vouchers submitted in the same
 * second would both read the same max and mint the same code. `findOneAndUpdate`
 * with `$inc` is a single atomic document update, so concurrent callers are
 * always handed distinct numbers.
 */
const counterSchema = new mongoose.Schema(
  {
    // e.g. 'voucher:2026', 'expense:2026' — the series is per key, so each year
    // restarts at 1 without colliding with the previous year's codes.
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Counter', counterSchema);
