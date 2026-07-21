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
router.get('/me', listMyExpenses);
router.post('/', receiptUpload.single('receipt'), createExpense);
// Receipt view — owner OR expenses.manage (checked inside the handler), so the
// owning employee (who lacks expenses.manage) can still open their own receipt.
router.get('/:id/receipt', downloadReceipt);

// HR/Admin
router.use(requirePermission('expenses.manage'));
router.get('/accounts', listAccounts); // cashbook accounts to pay a reimbursement from
router.get('/', listExpenses);
router.patch('/:id/status', reviewExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
