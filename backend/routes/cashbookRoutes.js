const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/cashbookController');
const { protect, protectMedia, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB receipts; images or PDF only.
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only image or PDF receipts are accepted'), ok);
  },
});

// Receipt streaming authenticates via ?access_token= (a media element/link can't
// set an Authorization header). The handler does its own owner/manager check.
router.get('/entries/:id/receipt', protectMedia, ctrl.getReceipt);

router.use(protect);

// ----- Employee self-service -----
router.get('/me', ctrl.listMyVouchers);
router.post('/me', receiptUpload.single('receipt'), ctrl.submitVoucher);
router.get('/me/categories', ctrl.listCategories); // category options for the voucher form

// ----- Finance (Account Manager / HR / Admin) -----
router.use(requirePermission('cashbook.manage'));

router.get('/overview', ctrl.overview);

router.get('/accounts', ctrl.listAccounts);
router.post('/accounts', ctrl.createAccount);
router.put('/accounts/:id', ctrl.updateAccount);
router.delete('/accounts/:id', ctrl.deleteAccount);

router.get('/categories', ctrl.listCategories);
router.post('/categories', ctrl.createCategory);
router.put('/categories/:id', ctrl.updateCategory);

router.get('/entries', ctrl.listEntries);
router.post('/entries', receiptUpload.single('receipt'), ctrl.createEntry);
router.put('/entries/:id', ctrl.updateEntry);
router.delete('/entries/:id', ctrl.deleteEntry);
router.patch('/entries/:id/review', ctrl.reviewVoucher);

router.post('/transfer', ctrl.transfer);

router.get('/reports/daybook', ctrl.daybook);
router.get('/reports/summary', ctrl.summary);
router.get('/reports/export', ctrl.exportCsv);

module.exports = router;
