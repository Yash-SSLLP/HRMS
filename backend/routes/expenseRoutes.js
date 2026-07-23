/**
 * Expense router — mounted at /api/expenses.
 * Employee expense-claim submission (multer receipt upload) plus HR/Admin
 * review, deletion, and cashbook-account lookup for reimbursements.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const multer = require('multer');
const {
  listMyExpenses, createExpense, listExpenses, reviewExpense, deleteExpense,
  downloadReceipt, listAccounts,
} = require('../controllers/expenseController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB receipts; images or PDF only (mirrors the cashbook receipt upload).
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only image or PDF receipts are accepted'), ok);
  },
});

router.use(protect);

// Employee self-service
// GET /me — current user's expense claims; protected.
router.get('/me', listMyExpenses);
// POST / — submit an expense claim; protected + multer single 'receipt' (5MB image/PDF).
router.post('/', receiptUpload.single('receipt'), createExpense);
// Receipt view — owner OR expenses.manage (checked inside the handler), so the
// owning employee (who lacks expenses.manage) can still open their own receipt.
// GET /:id/receipt — download an expense receipt; protected (owner or expenses.manage, checked in controller).
router.get('/:id/receipt', downloadReceipt);

// HR/Admin — everything below requires the 'expenses.manage' permission.
router.use(requirePermission('expenses.manage'));
router.get('/accounts', listAccounts); // GET /accounts — cashbook accounts to pay a reimbursement from; protected, requires 'expenses.manage'.
// GET / — list all expense claims; protected, requires 'expenses.manage'.
router.get('/', listExpenses);
// PATCH /:id/status — approve/reject/reimburse an expense; protected, requires 'expenses.manage'.
router.patch('/:id/status', reviewExpense);
// DELETE /:id — delete an expense claim; protected, requires 'expenses.manage'.
router.delete('/:id', deleteExpense);

module.exports = router;
