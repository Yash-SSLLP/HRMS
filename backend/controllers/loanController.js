const asyncHandler = require('express-async-handler');
const Loan = require('../models/Loan');

const USER_FIELDS = 'firstName lastName email';

// ===== Employee self-service =====
const listMine = asyncHandler(async (req, res) => {
  const loans = await Loan.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

const requestLoan = asyncHandler(async (req, res) => {
  const { type, principal, reason } = req.body;
  if (!(Number(principal) > 0)) {
    res.status(400);
    throw new Error('principal must be greater than 0');
  }
  if (!reason || !reason.trim()) {
    res.status(400);
    throw new Error('reason is required');
  }
  const loan = await Loan.create({
    employee: req.user._id,
    type: type || undefined,
    principal,
    balance: principal,
    reason,
    status: 'Pending',
  });
  res.status(201).json({ loan });
});

// ===== HR/Admin =====
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const loans = await Loan.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

const createForEmployee = asyncHandler(async (req, res) => {
  const { employee, type, principal, emi, tenureMonths, reason } = req.body;
  if (!employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  if (!(Number(principal) > 0)) {
    res.status(400);
    throw new Error('principal must be greater than 0');
  }
  const loan = await Loan.create({
    employee,
    type: type || undefined,
    principal,
    emi: emi || 0,
    tenureMonths: tenureMonths || 0,
    balance: principal,
    reason,
    status: 'Approved',
    reviewedBy: req.user._id,
  });
  res.status(201).json({ loan });
});

const reviewLoan = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  if (!loan) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const { status, reviewNote, emi, tenureMonths, disbursedOn } = req.body;
  if (status) loan.status = status;
  if (reviewNote !== undefined) loan.reviewNote = reviewNote;

  if (status === 'Approved' || status === 'Active') {
    if (emi !== undefined) loan.emi = emi;
    if (tenureMonths !== undefined) loan.tenureMonths = tenureMonths;
    if (disbursedOn !== undefined) loan.disbursedOn = disbursedOn;
  }
  if (status === 'Active' && loan.balance === 0) {
    loan.balance = loan.principal;
  }
  loan.reviewedBy = req.user._id;
  await loan.save();
  res.json({ loan });
});

const recordRepayment = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  if (!loan) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const amount = Number(req.body.amount);
  if (!(amount > 0)) {
    res.status(400);
    throw new Error('amount must be greater than 0');
  }
  loan.balance = Math.max(0, loan.balance - amount);
  if (loan.balance === 0) loan.status = 'Closed';
  await loan.save();
  res.json({ loan });
});

module.exports = {
  listMine, requestLoan, listAll, createForEmployee, reviewLoan, recordRepayment,
};
