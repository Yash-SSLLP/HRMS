/**
 * Loan router — mounted at /api/loans.
 * Employee loan/advance requests plus HR/Admin approval and repayments.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listMine, requestLoan, listAll, createForEmployee, reviewLoan, recordRepayment,
} = require('../controllers/loanController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /me — list current user's loans; protected.
router.get('/me', listMine);
// POST / — request a new loan/advance; protected.
router.post('/', requestLoan);

// HR/Admin — everything below requires the 'loans.manage' permission.
router.use(requirePermission('loans.manage'));
// GET / — list all loans; protected, requires 'loans.manage'.
router.get('/', listAll);
// POST /admin — create a loan on an employee's behalf; protected, requires 'loans.manage'.
router.post('/admin', createForEmployee);
// PATCH /:id/status — approve/reject a loan; protected, requires 'loans.manage'.
router.patch('/:id/status', reviewLoan);
// PATCH /:id/repay — record a loan repayment; protected, requires 'loans.manage'.
router.patch('/:id/repay', recordRepayment);

module.exports = router;
