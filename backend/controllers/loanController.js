/**
 * Loan controller — employee loan/advance requests and HR administration.
 * Employees request loans (start Pending); HR lists/creates (pre-Approved),
 * reviews status, and records repayments that draw down the balance.
 */
const asyncHandler = require('express-async-handler');
const Loan = require('../models/Loan');

// Populated employee sub-fields returned for loan references
const USER_FIELDS = 'firstName lastName email';

// ===== Employee self-service =====
/**
 * List the current user's own loans, newest first.
 * @route GET /api/loans/me
 * @returns {{count: number, loans: Object[]}}
 */
const listMine = asyncHandler(async (req, res) => {
  const loans = await Loan.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

/**
 * Employee submits a loan request (created with status Pending, balance=principal).
 * @route POST /api/loans/me
 * @param {string} [req.body.type]
 * @param {number} req.body.principal - required, > 0
 * @param {string} req.body.reason - required
 * @returns {{loan: Object}} the created loan (201)
 */
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
/**
 * List all loans, optionally filtered by status, newest first.
 * @route GET /api/loans   (HR/Admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, loans: Object[]}} loans with populated employee
 */
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const loans = await Loan.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

/**
 * HR creates a loan directly for an employee (created pre-Approved).
 * @route POST /api/loans   (HR/Admin)
 * @param {string} req.body.employee - required employee id
 * @param {number} req.body.principal - required, > 0
 * @param {string} [req.body.type]
 * @param {number} [req.body.emi]
 * @param {number} [req.body.tenureMonths]
 * @param {string} [req.body.reason]
 * @returns {{loan: Object}} the created loan (201), reviewedBy=current user
 */
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

/**
 * HR reviews/updates a loan: change status and, when approving/activating, set
 * EMI, tenure and disbursement details.
 * @route PATCH /api/loans/:id/review   (HR/Admin)
 * @param {string} req.params.id - loan id
 * @param {string} [req.body.status]
 * @param {string} [req.body.reviewNote]
 * @param {number} [req.body.emi] - applied only when Approved/Active
 * @param {number} [req.body.tenureMonths] - applied only when Approved/Active
 * @param {string} [req.body.disbursedOn] - applied only when Approved/Active
 * @returns {{loan: Object}} the updated loan
 */
const reviewLoan = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  if (!loan) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const { status, reviewNote, emi, tenureMonths, disbursedOn } = req.body;
  if (status) loan.status = status;
  if (reviewNote !== undefined) loan.reviewNote = reviewNote;

  // EMI/tenure/disbursement only meaningful once approved or active
  if (status === 'Approved' || status === 'Active') {
    if (emi !== undefined) loan.emi = emi;
    if (tenureMonths !== undefined) loan.tenureMonths = tenureMonths;
    if (disbursedOn !== undefined) loan.disbursedOn = disbursedOn;
  }
  // Activating a fresh loan seeds the outstanding balance from the principal
  if (status === 'Active' && loan.balance === 0) {
    loan.balance = loan.principal;
  }
  loan.reviewedBy = req.user._id;
  await loan.save();
  res.json({ loan });
});

/**
 * Record a repayment against a loan, reducing its balance; auto-closes at zero.
 * @route POST /api/loans/:id/repayment   (HR/Admin)
 * @param {string} req.params.id - loan id
 * @param {number} req.body.amount - required, > 0
 * @returns {{loan: Object}} the updated loan (status Closed when balance hits 0)
 */
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
  // Draw down balance (never below zero) and close the loan when fully repaid
  loan.balance = Math.max(0, loan.balance - amount);
  if (loan.balance === 0) loan.status = 'Closed';
  await loan.save();
  res.json({ loan });
});

module.exports = {
  listMine, requestLoan, listAll, createForEmployee, reviewLoan, recordRepayment,
};
