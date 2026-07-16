const mongoose = require('mongoose');

// A cash/bank "book" the cashbook tracks. A business can keep several — e.g. a
// petty-cash tin, the main cash drawer, a bank account, or a per-project float.
const ACCOUNT_TYPES = ['Cash', 'Bank', 'PettyCash', 'Other'];

const cashAccountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: ACCOUNT_TYPES, default: 'Cash' },
    openingBalance: { type: Number, default: 0 },
    // Maintained by the controller and ALWAYS recomputed from the ledger after
    // any change, so it can never drift:
    //   openingBalance + Σ(approved 'in') − Σ(approved 'out')
    currentBalance: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    note: { type: String, trim: true, maxlength: 300 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CashAccount', cashAccountSchema);
module.exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
