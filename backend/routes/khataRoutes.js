/**
 * Employee-khata router — mounted at /api/khata.
 *
 * The per-employee cash ledger between the company and its staff: advances out,
 * settlements back, and a running "you will get / you will give" balance that
 * posts double-entry into the cashbook.
 *
 * TWO LAYERS OF ACCESS, and they are not the same thing:
 *   1. `khata.manage` opens the module. A SuperAdmin has it implicitly; an
 *      Accounts Manager has it by role; anyone at all can be given it with the
 *      standalone `khataAccess` flag, no admin role required.
 *   2. Moving real money additionally requires being listed as an operator on
 *      the specific CashAccount, with a per-transaction limit above which the
 *      entry parks for approval instead of paying out. Enforced in the
 *      controller via services/khataLedger.js → resolveDisburseRights, because
 *      it depends on which account the request names.
 *
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const ctrl = require('../controllers/khataController');
const { protect, protectMedia, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB receipts; images or PDF only — same limits as the cashbook.
const receiptUpload = createUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only image or PDF receipts are accepted'), ok);
  },
});

// Receipt streaming authenticates via ?access_token= as well as the header (a
// media element cannot set one). The handler does its own owner/manager check.
// GET /entries/:id/receipt — stream an entry receipt; protectMedia + owner-or-manager check in controller.
router.get('/entries/:id/receipt', protectMedia, ctrl.getReceipt);

router.use(protect);

// ----- Employee self-service — every authenticated user, own khata only -----
// GET /me — my balance and statement; protected.
router.get('/me', ctrl.getMyKhata);
// POST /me/request — ask for a cash advance (always Pending); protected.
router.post('/me/request', ctrl.requestAdvance);
// POST /me/settle — declare cash returned to the company (always Pending); protected + multer single 'receipt'.
router.post('/me/settle', receiptUpload.single('receipt'), ctrl.declareSettlement);
// POST /me/khatas — open a khata on my own account (name only; the limit stays the company's call); protected.
router.post('/me/khatas', ctrl.createMyKhata);

// ----- Khata operators — everything below requires 'khata.manage' -----
router.use(requirePermission('khata.manage'));

// GET /overview — receivable/payable totals and pending count; requires 'khata.manage'.
router.get('/overview', ctrl.overview);
// GET /accounts — the cash accounts I may pay employees from, with my limits; requires 'khata.manage'.
router.get('/accounts', ctrl.listMyAccounts);
// GET /employee-options — thin employee picker for the give-advance form; requires 'khata.manage'.
router.get('/employee-options', ctrl.employeeOptions);

// GET /employees — every khata with its balance; requires 'khata.manage'.
router.get('/employees', ctrl.listKhatas);
// GET /employees/:employeeId — one employee's khata and statement; requires 'khata.manage'.
router.get('/employees/:employeeId', ctrl.getKhata);

// ----- Individual khatas (an employee may hold several named books) -----
// POST /khatas — open a new named khata for an employee; requires 'khata.manage'.
router.post('/khatas', ctrl.createKhata);
// PUT /khatas/:khataId — rename, limit, note, make default, close (opening balance is SuperAdmin-only, checked in the controller); requires 'khata.manage'.
router.put('/khatas/:khataId', ctrl.updateKhataSettings);
// POST /khatas/:khataId/recompute — repair tool, rebuild one khata's balance from its ledger; SuperAdmin only.
router.post('/khatas/:khataId/recompute', restrictTo('SuperAdmin'), ctrl.recomputeKhata);

// GET /entries — ledger across all employees; requires 'khata.manage'.
router.get('/entries', ctrl.listEntries);
// POST /entries — give an advance or record a settlement; requires 'khata.manage' + operator rights on the account + multer single 'receipt'.
router.post('/entries', receiptUpload.single('receipt'), ctrl.createEntry);
// GET /pending — the khata approvals queue; requires 'khata.manage'.
router.get('/pending', ctrl.listPending);
// PATCH /entries/:id/approve — release a parked entry; requires 'khata.manage' + canApprove on the account.
router.patch('/entries/:id/approve', ctrl.approveEntry);
// PATCH /entries/:id/reject — decline a parked entry; requires 'khata.manage'.
router.patch('/entries/:id/reject', ctrl.rejectEntry);
// POST /entries/:id/reverse — cancel a posted entry with a mirror row (never a delete); requires 'khata.manage' + canApprove.
router.post('/entries/:id/reverse', ctrl.reverseEntry);

// ----- Reports -----
// GET /reports/outstanding — who is holding company cash, with ageing bands; requires 'khata.manage'.
router.get('/reports/outstanding', ctrl.outstandingReport);
// GET /reports/export — balances + full ledger as .xlsx; requires 'khata.manage'.
router.get('/reports/export', ctrl.exportExcel);
// POST /reports/remind — nudge everyone (or named people) holding company cash; requires 'khata.manage'.
router.post('/reports/remind', ctrl.sendSettleReminders);

// ----- Who may spend from which account — SuperAdmin only -----
// GET /accounts/:id/operators — the account's operator list; SuperAdmin only.
router.get('/accounts/:id/operators', restrictTo('SuperAdmin'), ctrl.listOperators);
// PUT /accounts/:id/operators — replace the operator list; SuperAdmin only.
router.put('/accounts/:id/operators', restrictTo('SuperAdmin'), ctrl.setOperators);

module.exports = router;
