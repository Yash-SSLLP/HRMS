const mongoose = require('mongoose');

/**
 * ONE cash wallet per employee — the single place company advance money sits.
 *
 * This is the pot. The company pays an advance INTO it; the employee then
 * records what they spent out of it against whichever khata (expense book) the
 * spend belongs to. There is exactly one wallet per person, so the answer to
 * "how much of our cash is this person holding?" is one number, not a sum you
 * have to assemble.
 *
 * WHY THIS EXISTS AT ALL. Advances used to be given to a specific khata, which
 * meant an employee holding a site book and a vehicle book had two separate
 * pots and had to ask for money against the right one — and could be flush on
 * one while unable to spend on the other. That is not how anybody actually
 * carries cash. Money in a pocket is fungible; the *reason* it was spent is
 * what needs separating. So the pot moved here, and EmployeeKhata became a
 * folder of expenses rather than a balance of its own.
 *
 * SIGN CONVENTION — held from the COMPANY's point of view, unchanged from the
 * ledger that feeds it:
 *
 *   balance > 0  → the employee is holding company cash they have not yet
 *                  accounted for. "Advance in hand."
 *   balance < 0  → the employee has spent more than they were advanced, so the
 *                  company owes them. "The company owes you."
 *   balance = 0  → square.
 *
 * The UI never prints "debit"/"credit" — see describeWalletForEmployee in the
 * controller for the exact wording each side gets.
 *
 * `balance` is a CACHE. It is always replayed from the Approved KhataEntry rows
 * of this employee (see services/khataLedger.js → recomputeWalletBalance),
 * exactly as CashAccount.currentBalance and the old per-khata balance were, so
 * it can never drift away from the ledger behind it.
 */
const employeeWalletSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },

    // Money the employee already held when the wallet was opened — an advance
    // handed over before this module existed, or the roll-up of the old
    // per-khata opening balances (see scripts/migrateKhataWallet.js). Same sign
    // convention as `balance`.
    openingBalance: { type: Number, default: 0 },

    // Replayed from the ledger, never incremented in place. See above.
    balance: { type: Number, default: 0, index: true },

    // Ceiling on how much advance this person may hold at once, across
    // everything. 0 = no limit. Checked when an advance is released: one that
    // would push `balance` past it is refused. Per PERSON now rather than per
    // book — the pot is the person's, so the limit is too.
    creditLimit: { type: Number, default: 0, min: 0 },

    // Denormalised for the "who should settle up" list, so ordering by
    // staleness needs no aggregate over every entry.
    lastEntryAt: { type: Date, default: null, index: true },

    note: { type: String, trim: true, maxlength: 300 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// The outstanding report: everyone still holding cash, worst first.
employeeWalletSchema.index({ balance: -1 });

module.exports = mongoose.model('EmployeeWallet', employeeWalletSchema);
