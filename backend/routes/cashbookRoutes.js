/**
 * Cashbook router — mounted at /api/cashbook.
 * Cash accounts + in/out ledger: employee voucher submission (multer
 * receipt upload) plus Finance/HR/Admin accounts, categories, entries,
 * transfers, and day-book/summary/CSV reports.
 * All routes require authentication (router.use(protect)).
 */
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
// GET /entries/:id/receipt — stream an entry receipt; protectMedia (header or ?access_token), owner/manager check in controller.
router.get('/entries/:id/receipt', protectMedia, ctrl.getReceipt);

router.use(protect);

// ----- Employee self-service -----
// GET /me — current user's submitted vouchers; protected.
router.get('/me', ctrl.listMyVouchers);
// POST /me — submit a voucher; protected + multer single 'receipt' (5MB image/PDF).
router.post('/me', receiptUpload.single('receipt'), ctrl.submitVoucher);
router.get('/me/categories', ctrl.listCategories); // GET /me/categories — category options for the voucher form; protected.

// ----- Finance (Account Manager / HR / Admin) — everything below requires 'cashbook.manage' -----
router.use(requirePermission('cashbook.manage'));

// GET /overview — cashbook overview/balances; protected, requires 'cashbook.manage'.
router.get('/overview', ctrl.overview);

// GET /accounts — list cash accounts; protected, requires 'cashbook.manage'.
router.get('/accounts', ctrl.listAccounts);
// POST /accounts — create a cash account; protected, requires 'cashbook.manage'.
router.post('/accounts', ctrl.createAccount);
// PUT /accounts/:id — update a cash account; protected, requires 'cashbook.manage'.
router.put('/accounts/:id', ctrl.updateAccount);
// DELETE /accounts/:id — delete a cash account; protected, requires 'cashbook.manage'.
router.delete('/accounts/:id', ctrl.deleteAccount);

// GET /categories — list categories; protected, requires 'cashbook.manage'.
router.get('/categories', ctrl.listCategories);
// POST /categories — create a category; protected, requires 'cashbook.manage'.
router.post('/categories', ctrl.createCategory);
// PUT /categories/:id — update a category; protected, requires 'cashbook.manage'.
router.put('/categories/:id', ctrl.updateCategory);

// GET /entries — list ledger entries; protected, requires 'cashbook.manage'.
router.get('/entries', ctrl.listEntries);
// POST /entries — create a ledger entry; protected, requires 'cashbook.manage' + multer single 'receipt'.
router.post('/entries', receiptUpload.single('receipt'), ctrl.createEntry);
// PUT /entries/:id — update a ledger entry; protected, requires 'cashbook.manage'.
router.put('/entries/:id', ctrl.updateEntry);
// DELETE /entries/:id — delete a ledger entry; protected, requires 'cashbook.manage'.
router.delete('/entries/:id', ctrl.deleteEntry);
// PATCH /entries/:id/review — approve/reject a submitted voucher; protected, requires 'cashbook.manage'.
router.patch('/entries/:id/review', ctrl.reviewVoucher);

// POST /transfer — transfer funds between accounts; protected, requires 'cashbook.manage'.
router.post('/transfer', ctrl.transfer);

// GET /reports/daybook — day-book report; protected, requires 'cashbook.manage'.
router.get('/reports/daybook', ctrl.daybook);
// GET /reports/summary — summary report; protected, requires 'cashbook.manage'.
router.get('/reports/summary', ctrl.summary);
// GET /reports/export — export ledger CSV; protected, requires 'cashbook.manage'.
router.get('/reports/export', ctrl.exportCsv);

module.exports = router;
