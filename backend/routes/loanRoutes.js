/**
 * Loan router — mounted at /api/loans.
 * Employee loan/advance requests plus HR/Admin approval and repayments.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listMine, requestLoan, listAll, employeeOptions, createForEmployee, reviewLoan, recordRepayment,
  getLoanForm, updateLoanForm, requireLoanFormEditor, myLoanFormPdf, loanFormPdf,
} = require('../controllers/loanController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// The Advance Request Form — above the loans.manage gate, because the employee
// filling it in needs it as much as the people who set it.
// GET /form — purposes, terms, declaration and the caller's own details; protected.
router.get('/form', getLoanForm);
// PUT /form — save the purposes and/or the terms; SuperAdmin, CEO, MD, or an
// HR Manager holding loans.manage (see requireLoanFormEditor).
router.put('/form', requireLoanFormEditor, updateLoanForm);

// Employee self-service
// GET /me — list current user's loans; protected.
router.get('/me', listMine);
// GET /me/:id/form.pdf — the borrower's own filled-in form; protected, own loans only.
router.get('/me/:id/form.pdf', myLoanFormPdf);
// POST / — submit the Advance Request Form; protected.
router.post('/', requestLoan);

// HR/Admin — everything below requires the 'loans.manage' permission.
router.use(requirePermission('loans.manage'));
// GET / — list all loans; protected, requires 'loans.manage'.
router.get('/', listAll);
// GET /employee-options — who a loan can be raised for; protected, requires 'loans.manage'.
// Its own picker because /admin/users is role-gated and this module is
// grantable to any account (User.loansAccess).
router.get('/employee-options', employeeOptions);
// GET /:id/form.pdf — any loan's form, to print and sign; requires 'loans.manage'
// (CEO/MD read it through the capability guard's read-only pass).
router.get('/:id/form.pdf', loanFormPdf);
// POST /admin — create a loan on an employee's behalf; protected, requires 'loans.manage'.
router.post('/admin', createForEmployee);
// PATCH /:id/status — approve/reject a loan; protected, requires 'loans.manage'.
router.patch('/:id/status', reviewLoan);
// PATCH /:id/repay — record a loan repayment; protected, requires 'loans.manage'.
router.patch('/:id/repay', recordRepayment);

module.exports = router;
