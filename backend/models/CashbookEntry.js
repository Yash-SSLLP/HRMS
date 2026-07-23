const mongoose = require('mongoose');

// One line of the cashbook: money IN (receipt) or OUT (payment) against an
// account. Finance-created entries post immediately (status 'Approved');
// employee-submitted petty-cash vouchers start 'Pending' and only affect the
// account balance once approved.
const ENTRY_TYPES = ['in', 'out']; // in = receipt/money in; out = payment/money out
// Pending -> voucher awaiting approval (no balance effect); Approved -> posted to balance; Rejected -> declined.
const ENTRY_STATUS = ['Pending', 'Approved', 'Rejected'];
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];

const attachmentSchema = new mongoose.Schema(
  { storagePath: String, name: String, sizeBytes: Number, mime: String },
  { _id: false }
);

const cashbookEntrySchema = new mongoose.Schema(
  {
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

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cashbookEntrySchema.index({ account: 1, date: 1, createdAt: 1 });

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
cashbookEntrySchema.plugin(require('./plugins/auditStatus'));

module.exports = mongoose.model('CashbookEntry', cashbookEntrySchema);
module.exports.ENTRY_TYPES = ENTRY_TYPES;
module.exports.ENTRY_STATUS = ENTRY_STATUS;
module.exports.PAYMENT_MODES = PAYMENT_MODES;
