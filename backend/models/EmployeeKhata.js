const mongoose = require('mongoose');

/**
 * One named cash account between the company and one employee — a "khata".
 *
 * An employee can hold SEVERAL. A site supervisor might carry a float for
 * "Site A — materials", another for "Vehicle & fuel", and a personal advance
 * against salary, and lumping those into a single number would make it
 * impossible to say what any one of them was actually for or to close one off
 * on its own. So money is always given to, and settled against, a *specific*
 * khata; the employee's overall position is the sum of theirs.
 *
 * The cashbook (CashAccount/CashbookEntry) answers "how much cash is in the
 * tin?". It cannot answer "how much is Rahul holding for Site A, and what has
 * he settled?", because there a payout is just a flat line with a party name on
 * it. This model is that missing counterparty view: one document per khata,
 * carrying its running balance, with KhataEntry rows behind it.
 *
 * SIGN CONVENTION — the single most important thing in this module.
 * `balance` is held from the COMPANY's point of view:
 *
 *   balance > 0  → the employee owes the company        ("You will get")
 *                  e.g. an advance was paid out and not yet settled
 *   balance < 0  → the company owes the employee        ("You will give")
 *                  e.g. they spent their own cash on a company purchase
 *   balance = 0  → square
 *
 * The UI must never print "debit"/"credit" at an employee — it prints those two
 * phrases. Internally the ledger stays signed so arithmetic is trivial.
 *
 * `balance` is a CACHE. It is always recomputed straight from the Approved
 * KhataEntry rows after any change (see services/khataLedger.js →
 * recomputeKhataBalance), exactly like CashAccount.currentBalance, so it can
 * never drift away from the ledger that backs it.
 */

/**
 * The name every employee's first khata gets. Self-service has to work with no
 * setup at all: an employee asking for money before anyone has organised their
 * books lands here rather than being told to go and create something first.
 */
const DEFAULT_KHATA_NAME = 'General';

const employeeKhataSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // What this particular book is for — "Site A — materials", "Vehicle & fuel",
    // "Salary advance". Shown everywhere money is given or settled, so it has to
    // read as a purpose rather than a code.
    name: { type: String, required: true, trim: true, maxlength: 80, default: DEFAULT_KHATA_NAME },

    // The one that self-service falls back to when no khata is named — the
    // employee's first. Exactly one per employee carries this; see
    // khataLedger.getOrCreateDefaultKhata.
    isDefault: { type: Boolean, default: false },

    // Money the employee already owed on this book when it was opened — e.g. an
    // advance handed over before this module existed. Counted into `balance`
    // with the same sign convention (positive = employee owes the company).
    openingBalance: { type: Number, default: 0 },

    // Recomputed from the ledger, never incremented in place. See above.
    balance: { type: Number, default: 0, index: true },

    // Ceiling on how much the employee may hold ON THIS KHATA at once. 0 = no
    // limit. Checked when disbursing: an advance that would push `balance` past
    // it is refused. Per-khata rather than per-person on purpose — a ₹50,000
    // site float and a ₹5,000 petty float want very different ceilings.
    creditLimit: { type: Number, default: 0, min: 0 },

    // Denormalised for the "settle up" list, so ordering by staleness does not
    // need an aggregate over every entry.
    lastEntryAt: { type: Date, default: null, index: true },

    // Closed khatas stay readable (financial history is never destroyed) but no
    // longer accept new entries and drop out of the outstanding list. A khata
    // carrying a balance cannot be closed — see the controller.
    isActive: { type: Boolean, default: true },

    note: { type: String, trim: true, maxlength: 300 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// One book per name per person: "Site A" must mean one thing for one employee,
// so a second khata of the same name is rejected rather than silently created
// alongside the first. Replaces the old one-khata-per-employee unique index —
// scripts/migrateMultiKhata.js drops that one from existing databases, since
// removing it from the schema does not remove it from Mongo.
employeeKhataSchema.index({ employee: 1, name: 1 }, { unique: true });

// The outstanding-report query: active khatas with a non-zero balance, worst first.
employeeKhataSchema.index({ isActive: 1, balance: -1 });

module.exports = mongoose.model('EmployeeKhata', employeeKhataSchema);
module.exports.DEFAULT_KHATA_NAME = DEFAULT_KHATA_NAME;
