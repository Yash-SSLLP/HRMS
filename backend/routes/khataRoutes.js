/**
 * Employee-khata router — mounted at /api/khata.
 *
 * The employee cash module: one WALLET per person that advances are paid into,
 * and as many KHATAS (expense books) as they want to file spending under. See
 * controllers/khataController.js for the shape of the thing.
 *
 * FOUR LAYERS OF ACCESS, and they are not the same thing:
 *   1. `khata.manage` opens the module. A SuperAdmin has it implicitly; an
 *      Accounts Manager has it by role; anyone at all can be given it with the
 *      standalone `khataAccess` flag, no admin role required.
 *   2. SANCTIONING an advance request is a separate, deliberately narrow grant:
 *      SuperAdmin, CEO or MD, and nobody else. It is the one write a read-only
 *      executive account is allowed, because it is the decision the role exists
 *      to make. See requireAdvanceApprover in middleware/authMiddleware.js.
 *   3. Moving real money additionally requires being listed as an operator on
 *      the specific CashAccount, with a per-transaction limit above which the
 *      entry parks for approval instead of paying out. Enforced in the
 *      controller via services/khataLedger.js → resolveDisburseRights, because
 *      it depends on which account the request names.
 *   4. Downloading the whole thing as a spreadsheet needs a FOURTH grant on top
 *      of (1): `khataExportAccess`, which only a SuperAdmin can set and which
 *      no role confers. See middleware/authMiddleware.js → canExportKhata.
 *
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const ctrl = require('../controllers/khataController');
const {
  protect, protectMedia, restrictTo, requirePermission, requireKhataExport, requireAdvanceApprover,
} = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB receipts; images or PDF only — same limits as the cashbook.
const receiptUpload = createUpload({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Extension as well as MIME: an Android file provider that cannot identify a
    // PDF sends application/octet-stream, and matching on the type alone
    // rejected a perfectly good receipt. Same fix as documentRoutes.
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
      || /\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Only image or PDF receipts are accepted'), ok);
  },
});

// Receipt streaming authenticates via ?access_token= as well as the header (a
// media element cannot set one). The handler does its own owner/manager check.
// GET /entries/:id/receipt — stream an entry receipt; protectMedia + owner-or-manager check in controller.
router.get('/entries/:id/receipt', protectMedia, ctrl.getReceipt);

router.use(protect);

// ----- Employee self-service — every authenticated user, own wallet only -----
// GET /me — my wallet, my expense books and my statement; protected.
router.get('/me', ctrl.getMyKhata);
// POST /me/request — ask for an advance into my wallet (always parks); protected.
router.post('/me/request', ctrl.requestAdvance);
// POST /me/expense — log what I spent the advance on, against one of my books; protected + multer single 'receipt'.
router.post('/me/expense', receiptUpload.single('receipt'), ctrl.recordMyExpense);
// PUT /me/expenses/:id — correct an expense of mine the company has not confirmed yet; protected + multer single 'receipt'.
router.put('/me/expenses/:id', receiptUpload.single('receipt'), ctrl.updateMyExpense);
// POST /me/reimbursement — claim back what the company owes me, when I have spent past my advance; protected.
router.post('/me/reimbursement', ctrl.requestReimbursement);
// POST /me/settle — declare unspent cash returned to the company (always parks); protected + multer single 'receipt'.
router.post('/me/settle', receiptUpload.single('receipt'), ctrl.declareSettlement);
// POST /me/khatas — open an expense book on my own account; protected.
router.post('/me/khatas', ctrl.createMyKhata);
// GET /me/statement.pdf — my khata as a printable statement with the bills
// attached; protected, own ledger only (the id comes from the token).
router.get('/me/statement.pdf', ctrl.myStatementPdf);

// ----- Executive sanction — SuperAdmin / CEO / MD only -----
// Mounted ABOVE the khata.manage gate on purpose: an executive holds no khata
// capability, and giving them one to reach these two routes would hand them the
// whole cash module. This is the narrower grant.
// GET /advance-approvals — advance requests awaiting a CEO/MD decision.
router.get('/advance-approvals', requireAdvanceApprover, ctrl.listAdvanceApprovals);
// PATCH /entries/:id/exec-decision — sanction or decline one; moves no money.
router.patch('/entries/:id/exec-decision', requireAdvanceApprover, ctrl.decideAdvanceApproval);

// ----- Khata operators — everything below requires 'khata.manage' -----
router.use(requirePermission('khata.manage'));

// GET /overview — receivable/payable totals and the two queue counts; requires 'khata.manage'.
router.get('/overview', ctrl.overview);
// GET /accounts — the cash accounts I may pay employees from, with my limits; requires 'khata.manage'.
router.get('/accounts', ctrl.listMyAccounts);
// GET /employee-options — thin employee picker for the give-advance form; requires 'khata.manage'.
router.get('/employee-options', ctrl.employeeOptions);

// GET /employees — every employee's wallet with their books; requires 'khata.manage'.
router.get('/employees', ctrl.listKhatas);
// GET /employees/:employeeId — one employee's wallet, books and statement; requires 'khata.manage'.
router.get('/employees/:employeeId', ctrl.getKhata);
// GET /employees/:employeeId/statement.pdf — that book (or every book) as a
// printable statement with the bills embedded; requires 'khata.manage'.
// Deliberately NOT behind requireKhataExport: that grant gates walking out with
// the whole company's ledger as data, not reading one person's book.
router.get('/employees/:employeeId/statement.pdf', ctrl.statementPdf);

// ----- The wallet: the one pot per employee -----
// PUT /wallets/:employeeId — advance limit and note (opening balance is SuperAdmin-only, checked in the controller); requires 'khata.manage'.
router.put('/wallets/:employeeId', ctrl.updateWalletSettings);
// POST /wallets/:employeeId/recompute — repair tool, rebuild a wallet and its books from the ledger; SuperAdmin only.
router.post('/wallets/:employeeId/recompute', restrictTo('SuperAdmin'), ctrl.recomputeWallet);

// ----- Expense books (an employee may hold several) -----
// POST /khatas — open a new named expense book for an employee; requires 'khata.manage'.
router.post('/khatas', ctrl.createKhata);
// PUT /khatas/:khataId — rename, re-note, make default, close; requires 'khata.manage'.
router.put('/khatas/:khataId', ctrl.updateKhataSettings);

// GET /entries — ledger across all employees; requires 'khata.manage'.
router.get('/entries', ctrl.listEntries);
// POST /entries — give an advance, record a settlement, or file an expense; requires 'khata.manage' + operator rights on the account + multer single 'receipt'.
router.post('/entries', receiptUpload.single('receipt'), ctrl.createEntry);
// GET /pending — what the accounts team must act on; requires 'khata.manage'.
router.get('/pending', ctrl.listPending);
// PATCH /entries/:id/approve — release a parked entry; requires 'khata.manage' + canApprove on the account.
router.patch('/entries/:id/approve', ctrl.approveEntry);
// PATCH /entries/:id/reject — decline a parked entry; requires 'khata.manage'.
router.patch('/entries/:id/reject', ctrl.rejectEntry);
// PUT /entries/:id — correct an unconfirmed expense on the employee's behalf; requires 'khata.manage' + multer single 'receipt'.
router.put('/entries/:id', receiptUpload.single('receipt'), ctrl.updateEntry);
// PATCH /entries/:id/confirm — accept a self-posted expense, which locks it against further edits; requires 'khata.manage'.
router.patch('/entries/:id/confirm', ctrl.confirmEntry);
// POST /entries/:id/reverse — cancel a posted entry with a mirror row (never a delete); requires 'khata.manage' + canApprove.
router.post('/entries/:id/reverse', ctrl.reverseEntry);

// ----- Reports -----
// GET /reports/outstanding — who is holding company cash, with ageing bands; requires 'khata.manage'.
router.get('/reports/outstanding', ctrl.outstandingReport);
// GET /reports/export — wallets + books + full ledger as .xlsx; requires 'khata.manage'
// PLUS the separate download grant (SuperAdmin, or User.khataExportAccess).
// Reading the ledger on screen and walking out with a file of it are different
// decisions, so the second one is its own tick — see middleware canExportKhata.
router.get('/reports/export', requireKhataExport, ctrl.exportExcel);
// POST /reports/remind — nudge everyone (or named people) holding company cash; requires 'khata.manage'.
router.post('/reports/remind', ctrl.sendSettleReminders);

// ----- Who may spend from which account — SuperAdmin only -----
// GET /accounts/:id/operators — the account's operator list; SuperAdmin only.
router.get('/accounts/:id/operators', restrictTo('SuperAdmin'), ctrl.listOperators);
// PUT /accounts/:id/operators — replace the operator list; SuperAdmin only.
router.put('/accounts/:id/operators', restrictTo('SuperAdmin'), ctrl.setOperators);

module.exports = router;
