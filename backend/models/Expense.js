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

const expenseSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'Other' },
    amount: { type: Number, required: true, min: 0 },
    expenseDate: { type: Date, required: true },
    description: { type: String, trim: true },
    merchant: { type: String, trim: true },
    receiptUrl: { type: String, trim: true }, // legacy free-text link (kept for old rows)
    receipt: { type: receiptSchema, default: null }, // uploaded receipt file (image/PDF)
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
    return ret;
  },
});

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
expenseSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
module.exports.EXPENSE_STATUS = EXPENSE_STATUS;
