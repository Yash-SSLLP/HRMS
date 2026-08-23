const mongoose = require('mongoose');

// An employee expense/reimbursement claim with a receipt. Once Reimbursed it
// auto-posts a matching cash-out row in the cashbook (see cashbookEntry ref).
const EXPENSE_CATEGORIES = ['Travel', 'Food', 'Accommodation', 'Supplies', 'Medical', 'Communication', 'Other'];
// Pending -> awaiting review; Approved -> sanctioned; Rejected -> denied; Reimbursed -> paid back to employee.
const EXPENSE_STATUS = ['Pending', 'Approved', 'Rejected', 'Reimbursed'];

// Uploaded receipt proof (image or PDF), mirrors CashbookEntry's attachment.
const receiptSchema = new mongoose.Schema(
  { storagePath: String, name: String, sizeBytes: Number, mime: String },
  { _id: false }
);

// Where the claimant was when they filed the claim — see the same field on
// KhataEntry for why it is kept and why `accuracy` travels with it.
// SUPER ADMINS ONLY: the toJSON transform below deletes it on the way out, and
// the admin list adds it back for a SuperAdmin. Stripping by default means a new
// endpoint that forgets about this field leaks nothing.
const geoSchema = new mongoose.Schema(
  { lat: Number, lng: Number, accuracy: Number, at: Date },
  { _id: false }
);

const expenseSchema = new mongoose.Schema(
  {
    // Short quotable reference (EXP-2026-00017), stamped on first save and never
    // rewritten — see services/sequence.js. Sparse because claims filed before
    // codes existed have none until the backfill script runs.
    code: { type: String, trim: true, unique: true, sparse: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'Other' },
    amount: { type: Number, required: true, min: 0 },
    expenseDate: { type: Date, required: true },
    description: { type: String, trim: true },
    merchant: { type: String, trim: true },
    receiptUrl: { type: String, trim: true }, // legacy free-text link (kept for old rows)
    receipt: { type: receiptSchema, default: null }, // uploaded receipt file (image/PDF)
    // Where the claim was filed from. Best-effort — a denied location permission
    // or a device with no fix leaves it null rather than blocking the claim.
    filedLocation: { type: geoSchema, default: null },
    status: { type: String, enum: EXPENSE_STATUS, default: 'Pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true },
    // Ledger row created when this claim is Reimbursed; its presence prevents
    // a second cash-out from being posted on repeated "Mark Reimbursed" clicks.
    cashbookEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'CashbookEntry', default: null },
  },
  { timestamps: true }
);

// toJSON transform: expose only whether a receipt exists, never its storage path.
expenseSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.hasReceipt = !!ret.receipt?.storagePath;
    if (ret.receipt) delete ret.receipt.storagePath; // never leak filesystem path
    // Where the claim was filed is for SuperAdmins alone. Removed here rather
    // than at each read, so the default for every existing and future caller is
    // "not exposed"; the one screen allowed to show it puts it back by hand.
    delete ret.filedLocation;
    return ret;
  },
});

// Stamp the quotable claim code before the first save.
expenseSchema.pre('save', require('../services/sequence').stampCode('EXP', 'expenseDate'));

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
expenseSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
module.exports.EXPENSE_STATUS = EXPENSE_STATUS;
