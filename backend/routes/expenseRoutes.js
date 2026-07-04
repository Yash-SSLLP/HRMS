const express = require('express');
const {
  listMyExpenses, createExpense, listExpenses, reviewExpense, deleteExpense,
} = require('../controllers/expenseController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/me', listMyExpenses);
router.post('/', createExpense);

// HR/Admin
router.use(requirePermission('expenses.manage'));
router.get('/', listExpenses);
router.patch('/:id/status', reviewExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
