const mongoose = require('mongoose');

/**
 * One line of an employee's cash ledger — a single movement of money between
 * the company and that employee.
 *
 * WHICH BOOK A ROW BELONGS TO. Every row moves the employee's WALLET (see
 * models/EmployeeWallet.js) — that is the pot, and `balanceAfter` is always the
 * wallet balance after this row. `khata` is the *expense book* it is filed
 * under, and only spending has one:
 *
 *   khata set   → an expense. "₹3,000 of the advance went on Site A materials."
 *   khata null  → money in or out of the wallet itself: an advance paid, cash
 *                 returned, a reimbursement, a payroll recovery, an opening
 *                 balance. None of those belong to any one expense book.
 *
 * DIRECTION IS THE ONLY THING THAT SETS THE SIGN.
 * Forget "debit"/"credit"; ask only which way the money went:
 *
 *   'to_employee'    company → employee.  wallet += amount
 *                    The employee now holds more company money.
 *                    e.g. an advance paid out, a reimbursement handed over.
 *
 *   'from_employee'  employee → company.  wallet -= amount
 *                    The advance in their hand shrinks, or the company's debt
 *                    to them grows. e.g. an expense filed against a khata,
 *                    unspent cash returned, an advance recovered from payroll.
 *
 * That single rule covers every type below, which is why `type` is only ever a
 * label for reporting — it never changes the arithmetic.
 *
 * DOUBLE-ENTRY WITH THE CASHBOOK.
 * When real company cash moves (an advance out of the petty-cash tin, a
 * settlement back into it) the entry also posts a CashbookEntry against that
 * account and stores it in `cashbookEntry`. So the company's cash position and
 * the employee's khata are two views of the same event and cannot disagree.
 * Some types move no company cash at all (`affectsCompanyCash: false`) — an
 * employee spending their OWN money, or an advance recovered through payroll.
 *
 * NOTHING IS EVER DELETED once it has posted. A wrong entry is REVERSED: the
 * original is marked 'Reversed' and a mirror-image row is written pointing back
 * at it via `reversalOf`. The audit trail stays intact and the balance still
 * lands where it should.
 */

// Which way the money moved. See the sign rule above.
const DIRECTIONS = ['to_employee', 'from_employee'];

// Why it moved. Reporting label only — never affects the balance arithmetic.
const ENTRY_TYPES = [
  'advance',        // to_employee   — advance paid into the employee's wallet
  'settlement',     // from_employee — employee hands unspent cash back
  'expense',        // from_employee — spend filed against a khata (needs `khata`)
  'reimbursement',  // to_employee   — company pays back spend the employee funded
  'salary_recovery',// from_employee — outstanding advance recovered via payroll
  'opening',        // either        — balance carried in when the wallet was opened
  'reversal',       // either        — the mirror row that cancels another entry
  'other',
];

/**
 * The one type that is filed against an expense book. Everything else moves the
 * wallet on its own. Stated once here so the ledger, the controller and the
 * migration cannot disagree about it.
 */
const KHATA_TYPES = ['expense'];

// AwaitingApproval -> an advance request waiting on a CEO/MD decision; it has
// not reached the people who handle cash yet. Pending -> with the cash
// operators, no balance effect yet. Approved -> posted, counts into the
// balance. Rejected -> declined, never counts. Reversed -> it DID post, was
// later cancelled by a reversal row, and no longer counts.
//
// The two waiting states are separate because they are two different decisions
// by two different people: "should this person get an advance at all?" is the
// executive's call, "which account does it come out of, and has the cash
// actually left?" is the operator's. Collapsing them would put the operators'
// queue in front of an executive who has no business seeing it, and would let a
// request be paid before it had been sanctioned.
const ENTRY_STATUS = ['AwaitingApproval', 'Pending', 'Approved', 'Rejected', 'Reversed'];

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Adjustment', 'Other'];

const attachmentSchema = new mongoose.Schema(
  { storagePath: String, name: String, sizeBytes: Number, mime: String },
  { _id: false }
);

/**
 * Where the phone (or browser) was when the entry was filed.
 *
 * Not where the money was spent — nobody can know that — but where the person
 * stood when they told us about it. On a module whose whole control is "the
 * employee is trusted to record their own spending honestly, with a bill", that
 * is a useful thing to have: an expense filed from the site it belongs to reads
 * differently from one filed from three states away.
 *
 * `accuracy` is the device's own error estimate in metres and is kept because a
 * ±2 km fix and a ±8 m fix are not the same evidence, and a reader who is not
 * told the difference will treat them as if they were.
 *
 * SEEN BY SUPER ADMINS ONLY. It never reaches any other client — see
 * publicEntry in controllers/khataController.js, which omits it unless the
 * viewer is a SuperAdmin, and omits it by default when no viewer is passed.
 */
const geoSchema = new mongoose.Schema(
  { lat: Number, lng: Number, accuracy: Number, at: Date },
  { _id: false }
);

const khataEntrySchema = new mongoose.Schema(
  {
    // Short quotable reference (KHT-2026-00042), stamped on first save and never
    // rewritten — see services/sequence.js.
    code: { type: String, trim: true, unique: true, sparse: true, index: true },

    // Whose khata this line belongs to.
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The expense book this spend is filed under. NULL for everything that
    // moves the wallet itself — see the note at the top of this file.
    khata: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeKhata', default: null, index: true },

    direction: { type: String, enum: DIRECTIONS, required: true },
    type: { type: String, enum: ENTRY_TYPES, default: 'other', index: true },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, default: Date.now, index: true },

    purpose: { type: String, trim: true, maxlength: 500 },
    category: { type: String, trim: true, default: 'Uncategorized' },
    paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
    referenceNo: { type: String, trim: true, maxlength: 60 },
    attachment: { type: attachmentSchema, default: null },

    // Where the employee was when they filed this. Captured on self-service
    // expenses; null on anything an operator recorded on the company's behalf,
    // and on any client that could not get a fix. SuperAdmin-visible only.
    filedLocation: { type: geoSchema, default: null },

    // ----- company cash leg -----
    // Whether real money left or entered a company cash account. False for an
    // employee's own spend and for payroll recovery, which move no company cash.
    affectsCompanyCash: { type: Boolean, default: true },
    // Which company book the cash moved through. Required when
    // affectsCompanyCash and the entry is Approved; may be blank while Pending,
    // since the approver decides which account to pay from.
    cashAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount', index: true },
    // The CashbookEntry this row posted. Written once, on approval.
    cashbookEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'CashbookEntry', default: null, index: true },

    status: { type: String, enum: ENTRY_STATUS, default: 'Pending', index: true },

    // ----- who did what -----
    // True when the employee themselves raised this (a request or a declared
    // return), as opposed to an operator posting it on the company's behalf.
    raisedByEmployee: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 500 },

    // ----- executive sanction (advance requests only) -----
    // Whether this row had to be sanctioned by a CEO/MD before it could reach
    // the cash operators. Stamped from the org setting AT REQUEST TIME rather
    // than read live, so switching the requirement off later does not rewrite
    // the history of a request that genuinely went through an executive — and
    // switching it on does not strand requests raised while it was off.
    execApprovalRequired: { type: Boolean, default: false },
    execApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    execApprovedAt: { type: Date, default: null },
    execNote: { type: String, trim: true, maxlength: 500 },

    // ----- the company's look at a self-posted expense -----
    // An expense posts on the spot (see recordMyExpense), so 'Approved' here
    // means "counted", not "checked". This flag is the checking: it is set when
    // somebody on the company side has actually looked at the bill and accepted
    // it, and it is what CLOSES the row to further editing.
    //
    // While it is false the entry is still a draft in everything but its effect
    // on the wallet: the employee who filed it may correct the amount, the
    // purpose, the book or the bill, and so may the company. That is deliberate
    // — a typo in a figure typed at a counter should be fixable by the person
    // who typed it, right up to the moment the company accepts it. Afterwards
    // it is a settled record and the only correction left is a reversal.
    confirmedByCompany: { type: Boolean, default: false },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    confirmedAt: { type: Date, default: null },

    // Every correction made before confirmation, oldest first. An edit is not a
    // deletion, but it does rewrite a figure the company may already have seen,
    // so what it used to say stays on the row rather than vanishing.
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

    // Snapshot of the employee's WALLET balance immediately after this row
    // posted — the statement's running-balance column. Always the wallet, even
    // on a row filed against a khata, because the wallet is the only thing that
    // has a balance. Recomputed whenever the ledger is rebuilt, so it stays
    // correct even after a back-dated insert.
    balanceAfter: Number,

    // ----- reversal chain (never delete a posted financial row) -----
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'KhataEntry', default: null, index: true },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'KhataEntry', default: null },
    reversalReason: { type: String, trim: true, maxlength: 500 },

    // ----- links back to the module that generated this row -----
    // Set when the entry was auto-posted rather than typed in by hand, so the
    // integration can find its own row again and never post it twice.
    sourceLoan: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan', default: null, index: true },
    sourceExpense: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null, index: true },
    sourcePayroll: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', default: null, index: true },

    // Client-supplied dedupe key. A retried "give advance" tap — a flaky mobile
    // network, a double press — reuses the key and the second call returns the
    // first row instead of paying the employee twice.
    idempotencyKey: { type: String, trim: true, unique: true, sparse: true, index: true },
  },
  { timestamps: true }
);

// The statement query: one employee's rows in date order.
khataEntrySchema.index({ employee: 1, date: 1, createdAt: 1 });
// The two approval queues — the executive one and the operators' one — are
// both read by status, oldest first.
khataEntrySchema.index({ status: 1, date: -1 });

/**
 * Signed effect this row has on the wallet balance, from the company's side.
 * Positive = the employee owes the company more.
 * @returns {number}
 */
khataEntrySchema.virtual('signedAmount').get(function signedAmount() {
  return this.direction === 'to_employee' ? this.amount : -this.amount;
});

// Stamp the quotable reference code before the first save.
khataEntrySchema.pre('save', require('../services/sequence').stampCode('KHT', 'date'));

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
khataEntrySchema.plugin(require('./plugins/auditStatus'));

module.exports = mongoose.model('KhataEntry', khataEntrySchema);
module.exports.DIRECTIONS = DIRECTIONS;
module.exports.ENTRY_TYPES = ENTRY_TYPES;
module.exports.KHATA_TYPES = KHATA_TYPES;
module.exports.ENTRY_STATUS = ENTRY_STATUS;
module.exports.PAYMENT_MODES = PAYMENT_MODES;
