const mongoose = require('mongoose');

/**
 * One line of an employee's khata — a single movement of money between the
 * company and that employee.
 *
 * DIRECTION IS THE ONLY THING THAT SETS THE SIGN.
 * Forget "debit"/"credit"; ask only which way the money went:
 *
 *   'to_employee'    company → employee.  balance += amount
 *                    The employee now holds (or owes) more company money.
 *                    e.g. an advance paid out, a reimbursement handed over.
 *
 *   'from_employee'  employee → company.  balance -= amount
 *                    The employee's debt shrinks, or the company's debt to them
 *                    grows. e.g. returning unspent float, repaying an advance,
 *                    or spending their own cash on a company purchase.
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
  'advance',        // to_employee   — cash float / advance paid out
  'settlement',     // from_employee — employee hands unspent or owed cash back
  'expense',        // from_employee — employee spent their own money for the company
  'reimbursement',  // to_employee   — company pays that spend back
  'salary_recovery',// from_employee — outstanding advance recovered via payroll
  'opening',        // either        — balance carried in when the khata was opened
  'reversal',       // either        — the mirror row that cancels another entry
  'other',
];

// Pending -> submitted, no balance effect yet. Approved -> posted, counts into
// the balance. Rejected -> declined, never counts. Reversed -> it DID post, was
// later cancelled by a reversal row, and no longer counts.
const ENTRY_STATUS = ['Pending', 'Approved', 'Rejected', 'Reversed'];

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Adjustment', 'Other'];

const attachmentSchema = new mongoose.Schema(
  { storagePath: String, name: String, sizeBytes: Number, mime: String },
  { _id: false }
);

const khataEntrySchema = new mongoose.Schema(
  {
    // Short quotable reference (KHT-2026-00042), stamped on first save and never
    // rewritten — see services/sequence.js.
    code: { type: String, trim: true, unique: true, sparse: true, index: true },

    // Whose khata this line belongs to.
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    khata: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeKhata', required: true, index: true },

    direction: { type: String, enum: DIRECTIONS, required: true },
    type: { type: String, enum: ENTRY_TYPES, default: 'other', index: true },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, default: Date.now, index: true },

    purpose: { type: String, trim: true, maxlength: 500 },
    category: { type: String, trim: true, default: 'Uncategorized' },
    paymentMode: { type: String, enum: PAYMENT_MODES, default: 'Cash' },
    referenceNo: { type: String, trim: true, maxlength: 60 },
    attachment: { type: attachmentSchema, default: null },

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

    // Snapshot of the employee's khata balance immediately after this row posted
    // — the statement's running-balance column. Recomputed whenever the ledger
    // is rebuilt, so it stays correct even after a back-dated insert.
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
// The approvals queue.
khataEntrySchema.index({ status: 1, date: -1 });

/**
 * Signed effect this row has on the khata balance, from the company's side.
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
module.exports.ENTRY_STATUS = ENTRY_STATUS;
module.exports.PAYMENT_MODES = PAYMENT_MODES;
