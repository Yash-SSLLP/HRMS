const asyncHandler = require('express-async-handler');
const Expense = require('../models/Expense');
const { EXPENSE_STATUS } = require('../models/Expense');
const CashAccount = require('../models/CashAccount');
const CashbookEntry = require('../models/CashbookEntry');
const { recomputeBalance } = require('./cashbookController');
const storage = require('../services/storage');
const { hasPermission } = require('../middleware/authMiddleware');
const { notify } = require('../services/notify');

const USER_FIELDS = 'firstName lastName email role';

// Persist a receipt file (image/PDF) for an expense and stamp its receipt sub-doc.
function attachReceipt(expense, file) {
  const saved = storage.saveBuffer({
    buffer: file.buffer,
    ownerType: 'expense',
    ownerId: expense._id,
    originalName: file.originalname,
  });
  expense.receipt = {
    storagePath: saved.storagePath,
    name: file.originalname,
    sizeBytes: saved.sizeBytes,
    mime: file.mimetype,
  };
}

// ===== Employee self-service =====
const listMyExpenses = asyncHandler(async (req, res) => {
  const expenses = await Expense.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: expenses.length, expenses });
});

const createExpense = asyncHandler(async (req, res) => {
  const { amount, expenseDate } = req.body;
  if (amount === undefined || amount === null || Number(amount) <= 0) {
    res.status(400);
    throw new Error('A positive amount is required');
  }
  if (!expenseDate) {
    res.status(400);
    throw new Error('expenseDate is required');
  }
  if (!req.file) {
    res.status(400);
    throw new Error('A receipt file (image or PDF) is required');
  }
  const { category, description, merchant } = req.body;
  const expense = await Expense.create({
    employee: req.user._id,
    category,
    amount,
    expenseDate,
    description,
    merchant,
    status: 'Pending',
  });
  attachReceipt(expense, req.file);
  await expense.save();
  res.status(201).json({ expense });
});

// GET /api/expenses/:id/receipt — stream the receipt (owner or expenses.manage)
const downloadReceipt = asyncHandler(async (req, res) => {
  const expense = await Expense.findById(req.params.id).select('receipt employee');
  if (!expense || !expense.receipt?.storagePath) {
    res.status(404);
    throw new Error('Receipt not found');
  }
  const isOwner = String(expense.employee) === String(req.user._id);
  if (!isOwner && !hasPermission(req.user, 'expenses.manage')) {
    res.status(403);
    throw new Error('Not allowed');
  }
  if (expense.receipt.mime) res.setHeader('Content-Type', expense.receipt.mime);
  if (!storage.streamTo(expense.receipt.storagePath, res)) {
    res.status(404);
    throw new Error('Receipt file missing');
  }
});

// ===== HR/Admin =====
const listExpenses = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const expenses = await Expense.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: expenses.length, expenses });
});

// GET /api/expenses/accounts — active cashbook accounts to pay a reimbursement from.
// Exposed here (gated by expenses.manage) so a reviewer without cashbook.manage
// can still pick a paying account.
const listAccounts = asyncHandler(async (req, res) => {
  const accounts = await CashAccount.find({ isActive: true })
    .select('name type currentBalance currency')
    .sort({ name: 1 })
    .lean();
  res.json({ count: accounts.length, accounts });
});

// Post a cash-out ledger entry for a reimbursed expense and copy its receipt over.
async function postReimbursementToCashbook(expense, accountId, actor) {
  const acc = await CashAccount.findById(accountId);
  if (!acc) {
    const err = new Error('Account not found');
    err.statusCode = 404;
    throw err;
  }
  await expense.populate('employee', USER_FIELDS);
  const emp = expense.employee;
  const who = emp && emp.firstName ? `${emp.firstName} ${emp.lastName}`.trim() : 'Employee';

  const entry = await CashbookEntry.create({
    account: accountId,
    type: 'out',
    amount: expense.amount,
    date: expense.expenseDate || new Date(),
    category: 'Employee Reimbursement',
    paymentMode: 'Bank',
    description: `Expense reimbursement — ${expense.category}${expense.merchant ? ` (${expense.merchant})` : ''}`,
    party: who,
    status: 'Approved',
    sourceExpense: expense._id,
    createdBy: actor._id,
  });

  // Copy the employee's receipt onto the ledger entry so cashbook-access users
  // can verify the payment via the existing /cashbook/entries/:id/receipt view.
  if (expense.receipt?.storagePath) {
    try {
      const buffer = storage.readBuffer(expense.receipt.storagePath);
      const saved = storage.saveBuffer({
        buffer,
        ownerType: 'cashbook',
        ownerId: entry._id,
        originalName: expense.receipt.name || 'receipt',
      });
      entry.attachment = {
        storagePath: saved.storagePath,
        name: expense.receipt.name,
        sizeBytes: saved.sizeBytes,
        mime: expense.receipt.mime,
      };
    } catch (err) {
      console.error('expense receipt copy failed:', err.message);
    }
  }

  const balance = await recomputeBalance(accountId);
  entry.balanceAfter = balance;
  await entry.save();
  return entry;
}

const reviewExpense = asyncHandler(async (req, res) => {
  const { status, reviewNote, account } = req.body;
  if (!EXPENSE_STATUS.includes(status)) {
    res.status(400);
    throw new Error('Invalid status');
  }
  const expense = await Expense.findById(req.params.id);
  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
  }

  // On payout, post a cash-out entry to the cashbook (once — the link guards
  // against a second post on repeated "Mark Reimbursed" clicks).
  if (status === 'Reimbursed' && !expense.cashbookEntry) {
    if (!account) {
      res.status(400);
      throw new Error('Pick a cashbook account to pay this reimbursement from');
    }
    const entry = await postReimbursementToCashbook(expense, account, req.user);
    expense.cashbookEntry = entry._id;
    if (expense.employee) {
      notify({
        recipient: expense.employee,
        type: 'expense',
        audience: 'employee',
        title: 'Expense reimbursed',
        body: `Your ₹${expense.amount} expense claim was reimbursed.`,
        link: '/employee/expenses',
      }).catch((err) => console.error('expense reimburse notify failed:', err.message));
    }
  }

  expense.status = status;
  expense.reviewNote = reviewNote;
  expense.reviewedBy = req.user._id;
  expense.reviewedAt = new Date();
  await expense.save();
  res.json({ expense });
});

const deleteExpense = asyncHandler(async (req, res) => {
  const expense = await Expense.findById(req.params.id);
  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
  }
  if (expense.receipt?.storagePath) {
    try { storage.remove(expense.receipt.storagePath); } catch { /* ignore */ }
  }
  await expense.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listMyExpenses, createExpense, listExpenses, reviewExpense, deleteExpense,
  downloadReceipt, listAccounts, EXPENSE_STATUS,
};
