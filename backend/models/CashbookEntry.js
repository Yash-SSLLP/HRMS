const mongoose = require('mongoose');

// One line of the cashbook: money IN (receipt) or OUT (payment) against an
// account. Finance-created entries post immediately (status 'Approved');
// employee-submitted petty-cash vouchers start 'Pending' and only affect the
// account balance once approved.
const ENTRY_TYPES = ['in', 'out']; // in = receipt/money in; out = payment/money out
// AwaitingApproval -> an employee advance waiting on a CEO/MD sanction (no balance
// effect); Pending -> voucher/advance awaiting the cash operator (no balance
// effect); Approved -> posted to balance; Rejected -> declined; Reversed -> undone
// by a mirror row (never deleted).
const ENTRY_STATUS = ['AwaitingApproval', 'Pending', 'Approved', 'Rejected', 'Reversed'];
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];

// Which ledger a row belongs to. 'company' = the classic cashbook line (money in
// or out of a company account). 'employee' = a line of one person's running cash
// account with the company — the advances they hold and what they spend them on.
// Both live in this one collection: the two used to be separate ledgers (the
// cashbook and the "khata"), and an advance wrote a row in each. They are now one
// row, so the company's cash position and the employee's balance can never
// disagree. See services/khataLedger.js.
const LEDGERS = ['company', 'employee'];

// For an 'employee' row: which way the money moved between company and person.
//   to_employee   company → employee (advance paid out, reimbursement)  wallet +=
//   from_employee employee → company (settlement, spend, recovery)      wallet -=
const DIRECTIONS = ['to_employee', 'from_employee'];

// What an 'employee' row actually is. `type` (in/out) stays the company's view of
// the cash; this is the person's view of the event.
const MOVEMENTS = [
  'advance',        // to_employee   — advance paid into the person's wallet
  'settlement',     // from_employee — unspent cash handed back
  'expense',        // from_employee — spend filed against an expense book
  'reimbursement',  // to_employee   — company pays back spend they funded
  'salary_recovery',// from_employee — outstanding advance recovered via payroll
  'opening',        // either        — balance carried in when the wallet was opened
  'reversal',       // either        — the mirror row that cancels another entry
  'other',
];

const attachmentSchema = new mongoose.Schema(
  { storagePath: String, name: String, sizeBytes: Number, mime: String },
  { _id: false }
);

// Where the person was when they filed a self-service expense. Best-effort and
// SUPER ADMIN ONLY — never serialised for anyone else (see publicEntry).
const geoSchema = new mongoose.Schema(
  { lat: Number, lng: Number, accuracy: Number, at: Date },
  { _id: false }
);

const cashbookEntrySchema = new mongoose.Schema(
  {
    // Short quotable reference (VCH-2026-00042), stamped on first save and never
    // rewritten — see services/sequence.js. Sparse because rows created before
    // codes existed have none until the backfill script runs.
    code: { type: String, trim: true, unique: true, sparse: true, index: true },
    // Required once Approved; an employee voucher may be Pending with no account
    // until the reviewer picks which book to pay it from.
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount', index: true },
    type: { type: String, enum: ENTRY_TYPES, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, default: Date.now, index: true },
    category: { type: String, trim: true, default: 'Uncategorized' },
    paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
    description: { type: String, trim: true, maxlength: 500 },
    party: { type: String, trim: true, maxlength: 120 },      // payee / payer
    referenceNo: { type: String, trim: true, maxlength: 60 }, // voucher / bill no
    attachment: { type: attachmentSchema, default: null },
    status: { type: String, enum: ENTRY_STATUS, default: 'Approved', index: true },

    // Employee-submitted petty-cash voucher (starts Pending, no balance effect
    // until a reviewer approves it into an 'out' entry).
    submittedByEmployee: { type: Boolean, default: false },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // submitter
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true },

    // Snapshot of the account balance right after this entry posted — used for
    // the day-book running-balance column (also recomputable on demand).
    balanceAfter: Number,

    // The two legs of an account-to-account transfer share a transferGroup id.
    transferGroup: { type: mongoose.Schema.Types.ObjectId, index: true },

    // Set when this ledger row was auto-posted from a reimbursed expense claim.
    sourceExpense: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null, index: true },

    // LEGACY: set on rows that were the company-cash leg of a separate KhataEntry,
    // back when the two ledgers were distinct. Kept so historical rows still point
    // at what created them; nothing new writes it (the movement now lives on this
    // same row — see the employee-ledger block below).
    sourceKhataEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'KhataEntry', default: null, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  // `ledger` is the discriminator key: querying the EmployeeLedgerEntry model
  // below filters to employee rows automatically and stamps the key on create,
  // so no caller can forget it and leak one ledger's rows into the other's view.
  // Querying the BASE model returns both, which is what the account views want —
  // an advance that left the petty-cash tin is a real movement of that account.
  { timestamps: true, discriminatorKey: 'ledger' }
);

cashbookEntrySchema.index({ account: 1, date: 1, createdAt: 1 });

// Stamp the quotable reference before the first save. An employee-ledger row
// keeps the KHT series it has always used; a company row stays VCH — so existing
// references in people's records still resolve to the same kind of document.
cashbookEntrySchema.pre('save', async function stampSeries() {
  if (this.code) return;
  const { nextCode } = require('../services/sequence');
  const series = this.ledger === 'employee' ? 'KHT' : 'VCH';
  try {
    this.code = await nextCode(series, this.get('date'));
  } catch (err) {
    // A counter hiccup must not block the money record itself; it goes out
    // without a code and can be backfilled.
    console.error(`Could not mint a ${series} code:`, err.message);
  }
});

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
cashbookEntrySchema.plugin(require('./plugins/auditStatus'));

const CashbookEntry = mongoose.model('CashbookEntry', cashbookEntrySchema);

// ===================== the employee ledger =====================
// One line of a person's running cash account with the company: the advances
// they hold and what they spend them on. Stored in the SAME collection as the
// company cashbook (see the discriminator note above) so a single advance is one
// row, not two that can drift apart.
const employeeLedgerSchema = new mongoose.Schema(
  {
    // Which way the money moved between the company and the person.
    direction: { type: String, enum: DIRECTIONS, required: true },
    // What the event was from the person's side (advance / expense / …).
    movement: { type: String, enum: MOVEMENTS, default: 'other', index: true },
    // The expense book this spend is filed under. Null for anything that moves
    // the wallet itself (an advance, a settlement, a reimbursement).
    expenseBook: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeKhata', default: null, index: true },
    // Whether real company cash moved. FALSE for a person's own spend and for
    // payroll recovery — those change what is owed without any tin being opened,
    // so they must never touch an account balance.
    affectsCompanyCash: { type: Boolean, default: true },
    // What the person wrote it down as (their side of the description).
    purpose: { type: String, trim: true, maxlength: 500 },
    // Where they filed it from. SuperAdmin-visible only.
    filedLocation: { type: geoSchema, default: null },
    // True when the person themselves raised this, rather than an operator
    // recording it for them. Decides who may still edit it.
    raisedByEmployee: { type: Boolean, default: false },

    // Snapshot of the PERSON'S WALLET balance immediately after this row posted —
    // the statement's running-balance column. Deliberately separate from the
    // base `balanceAfter`, which is the ACCOUNT's balance: a row that both pays
    // an advance and empties a tin sits in both ledgers and needs both figures.
    // Recomputed whenever the ledger is rebuilt, so a back-dated insert is safe.
    walletBalanceAfter: Number,

    // ----- executive sanction (advance requests only) -----
    // Stamped from the org setting AT REQUEST TIME, not read live, so changing
    // the requirement later never rewrites the history of a request.
    execApprovalRequired: { type: Boolean, default: false },
    execApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    execApprovedAt: { type: Date, default: null },
    execNote: { type: String, trim: true, maxlength: 500 },

    // ----- the company's look at a self-posted expense -----
    // An expense posts on the spot, so 'Approved' means "counted", not "checked".
    // This is the checking, and it is what CLOSES the row to further editing.
    confirmedByCompany: { type: Boolean, default: false, index: true },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    confirmedAt: { type: Date, default: null },
    // Append-only trail of corrections made before confirmation.
    edits: {
      type: [new mongoose.Schema({
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        byEmployee: { type: Boolean, default: false },
        // Human-readable, e.g. 'amount ₹500 → ₹550; what for: "cement" → "sand"'.
        summary: { type: String, trim: true, maxlength: 600 },
      }, { _id: false })],
      default: [],
    },

    // ----- links back to the module that generated this row -----
    // Set when the entry was auto-posted rather than typed by hand, so the
    // integration can find its own row again and never post it twice.
    sourceLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', default: null, index: true },
    sourcePayroll: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', default: null, index: true },

    // ----- reversal chain (never delete a posted financial row) -----
    // On a mirror row: the entry it cancels. On the original: the mirror.
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'CashbookEntry', default: null, index: true },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'CashbookEntry', default: null },
    reversalReason: { type: String, trim: true, maxlength: 500 },

    // Guards against a double-post when a client retries a request.
    idempotencyKey: { type: String, trim: true, unique: true, sparse: true, index: true },

    // The legacy KhataEntry this row was folded in from, back when the employee
    // ledger was a separate collection. Provenance for reconciliation, and what
    // makes scripts/mergeKhataIntoCashbook.js safe to re-run.
    migratedFrom: { type: mongoose.Schema.Types.ObjectId, default: null, index: true, sparse: true },
  },
  { timestamps: true }
);

employeeLedgerSchema.index({ employee: 1, date: -1 });

const EmployeeLedgerEntry = CashbookEntry.discriminator('employee', employeeLedgerSchema);

module.exports = CashbookEntry;
module.exports.EmployeeLedgerEntry = EmployeeLedgerEntry;
module.exports.ENTRY_TYPES = ENTRY_TYPES;
module.exports.ENTRY_STATUS = ENTRY_STATUS;
module.exports.PAYMENT_MODES = PAYMENT_MODES;
module.exports.LEDGERS = LEDGERS;
module.exports.DIRECTIONS = DIRECTIONS;
module.exports.MOVEMENTS = MOVEMENTS;
