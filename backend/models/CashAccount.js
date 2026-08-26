const mongoose = require('mongoose');

// A cash/bank "book" the cashbook tracks. A business can keep several — e.g. a
// petty-cash tin, the main cash drawer, a bank account, or a per-project float.
const ACCOUNT_TYPES = ['Cash', 'Bank', 'PettyCash', 'Other'];

/**
 * Who may hand company money to an employee out of THIS account, and how much
 * they may hand over without anyone else signing it off.
 *
 * Holding the `khata.manage` capability is not enough on its own: it only opens
 * the module. Paying real cash out of a particular book additionally requires
 * being listed here, so the person who runs the petty-cash tin can pay a ₹2,000
 * advance out of it while never being able to touch the main bank account.
 *
 * `maxPerTransaction` is the auto-approve threshold, not a hard ceiling. Up to
 * it, the operator disburses directly and the money moves at once. Above it the
 * entry is still accepted but parks as Pending for a SuperAdmin to approve
 * before any cash leaves — so an urgent large payout is never blocked outright,
 * it just needs a second pair of eyes. 0 means no threshold: always direct.
 *
 * A SuperAdmin is implicitly an operator on every account with no threshold,
 * which is what bootstraps a freshly created account before anyone is listed.
 */
const accountOperatorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // False parks every one of this operator's payouts for approval, whatever
    // the amount — useful for someone who should record cash but never release it.
    canDisburse: { type: Boolean, default: true },
    // Auto-approve ceiling per transaction, in account currency. 0 = no limit.
    maxPerTransaction: { type: Number, default: 0, min: 0 },
    // Whether this operator may also approve OTHER people's parked entries on
    // this account. Off by default — releasing your own payout should not be
    // the same grant as releasing someone else's.
    canApprove: { type: Boolean, default: false },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

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

    // Which company's money this book holds. Null = shared/legacy, visible to
    // every cashbook operator; set, the account AND its ledger are walled to
    // that company's admins (utils/employeeScope).
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },

    // Employee-khata operators for this account — see accountOperatorSchema.
    // Empty means only a SuperAdmin can pay employees out of this book.
    // Does NOT affect the ordinary cashbook routes, which stay on
    // `cashbook.manage`; this list governs khata disbursement only.
    operators: { type: [accountOperatorSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// "Which accounts may I pay an employee from?" — the picker on every give-advance form.
cashAccountSchema.index({ 'operators.user': 1, isActive: 1 });

module.exports = mongoose.model('CashAccount', cashAccountSchema);
module.exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
