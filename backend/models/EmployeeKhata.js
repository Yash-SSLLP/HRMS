const mongoose = require('mongoose');

/**
 * One named EXPENSE BOOK belonging to an employee — a "khata".
 *
 * A khata is a folder for spending, not a pot of money. The money lives in the
 * employee's single wallet (see models/EmployeeWallet.js); a khata answers the
 * other question — what was it spent ON. A site supervisor carrying one advance
 * might open "Site A — materials", "Vehicle & fuel" and "Client hospitality",
 * and file each purchase under the right one. Every khata spends out of the
 * same wallet, so the remaining advance reads the same whichever book you have
 * open, and one book is never flush while another is empty.
 *
 * WHY IT WORKS THIS WAY. Advances used to be given to a specific khata, so an
 * employee had several separate pots and had to ask for money against the right
 * one. That is not how carrying cash works: notes in a pocket are fungible, and
 * only the *reason* they were spent needs separating. So the balance moved to
 * the wallet and this model kept the categorisation, which is the part that was
 * genuinely useful.
 *
 * `spent` is therefore a TOTAL, never a balance: the sum of the approved
 * expenses filed under this book. It only ever goes up (a reversal takes it
 * back down by cancelling the row it reverses). It is a cache, replayed from
 * the KhataEntry rows after any change — see services/khataLedger.js →
 * recomputeKhataSpent — so it cannot drift from the ledger behind it.
 *
 * The cashbook (CashAccount/CashbookEntry) answers "how much cash is in the
 * tin?"; the wallet answers "how much is Rahul holding?"; this answers "and
 * what did he spend it on?".
 */

/**
 * The name every employee's first khata gets. Self-service has to work with no
 * setup at all: somebody filing their first expense before anyone has organised
 * their books lands here rather than being told to go and create something.
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

    // What this book is for — "Site A — materials", "Vehicle & fuel", "Client
    // hospitality". Shown on every expense, so it has to read as a purpose
    // rather than a code.
    name: { type: String, required: true, trim: true, maxlength: 80, default: DEFAULT_KHATA_NAME },

    // The one that self-service falls back to when no book is named — the
    // employee's first. Exactly one per employee carries this; see
    // khataLedger.getOrCreateDefaultKhata.
    isDefault: { type: Boolean, default: false },

    // Total approved spend filed under this book. A running TOTAL, not a
    // balance: the money itself is in the wallet. Replayed from the ledger,
    // never incremented in place.
    spent: { type: Number, default: 0, index: true },

    // How many approved expenses make up `spent`. Denormalised so a list of
    // books does not need a count query per row.
    entryCount: { type: Number, default: 0 },

    // Denormalised for sorting books by recent activity.
    lastEntryAt: { type: Date, default: null, index: true },

    // Closed books stay readable (financial history is never destroyed) but no
    // longer accept new expenses and drop out of the pickers. Unlike the old
    // balance-carrying khata, a book with spend on it CAN be closed — the spend
    // is history, not an outstanding amount.
    isActive: { type: Boolean, default: true },

    note: { type: String, trim: true, maxlength: 300 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // ---- legacy, pre-wallet ----
    // These carried the per-khata pot before advances moved to the wallet.
    // Kept on the schema (rather than dropped) so scripts/migrateKhataWallet.js
    // can read what the old books held and roll it into the wallet; nothing in
    // the running code reads them any more.
    balance: { type: Number, default: 0 },
    openingBalance: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// One book per name per person: "Site A" must mean one thing for one employee,
// so a second khata of the same name is rejected rather than silently created
// alongside the first.
employeeKhataSchema.index({ employee: 1, name: 1 }, { unique: true });

// The "where has this person's money gone" query: their books, biggest first.
employeeKhataSchema.index({ employee: 1, spent: -1 });

module.exports = mongoose.model('EmployeeKhata', employeeKhataSchema);
module.exports.DEFAULT_KHATA_NAME = DEFAULT_KHATA_NAME;
