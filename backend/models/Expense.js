const mongoose = require('mongoose');

const EXPENSE_CATEGORIES = ['Travel', 'Food', 'Accommodation', 'Supplies', 'Medical', 'Communication', 'Other'];
const EXPENSE_STATUS = ['Pending', 'Approved', 'Rejected', 'Reimbursed'];

const expenseSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'Other' },
    amount: { type: Number, required: true, min: 0 },
    expenseDate: { type: Date, required: true },
    description: { type: String, trim: true },
    merchant: { type: String, trim: true },
    receiptUrl: { type: String, trim: true },
    status: { type: String, enum: EXPENSE_STATUS, default: 'Pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true },
  },
  { timestamps: true }
);

expenseSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
module.exports.EXPENSE_STATUS = EXPENSE_STATUS;
