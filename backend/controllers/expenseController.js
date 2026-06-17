const asyncHandler = require('express-async-handler');
const Expense = require('../models/Expense');
const { EXPENSE_STATUS } = require('../models/Expense');

const USER_FIELDS = 'firstName lastName email role';

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
  const { category, description, merchant, receiptUrl } = req.body;
  const expense = await Expense.create({
    employee: req.user._id,
    category,
    amount,
    expenseDate,
    description,
    merchant,
    receiptUrl,
    status: 'Pending',
  });
  res.status(201).json({ expense });
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

const reviewExpense = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;
  if (!EXPENSE_STATUS.includes(status)) {
    res.status(400);
    throw new Error('Invalid status');
  }
  const expense = await Expense.findById(req.params.id);
  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
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
  await expense.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listMyExpenses, createExpense, listExpenses, reviewExpense, deleteExpense, EXPENSE_STATUS,
};
