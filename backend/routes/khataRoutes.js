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
 * AND ONE THAT IS NOT A GRANT AT ALL. An employee can share one of their own
 * expense books with a colleague, who accepts and can then file into it (or just
 * read it). Nobody in the company hands that out — it is one employee lending
 * another a heading to file under — so those routes sit in the self-service
 * block above the `khata.manage` gate, and the standing they confer is checked
 * per book in services/khataLedger.js (canView / canPost), never per role.
 * Sharing moves no money: a collaborator's spending comes out of their OWN
 * wallet, and the owner's balance does not move.
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
//
// ROUTE ORDER MATTERS in this block. Express matches in declaration order, so
// every literal path (`/me/colleagues`, `/me/report.xlsx`) and every longer
// pattern (`/me/khatas/:id/members`) has to be declared BEFORE the shorter,
// greedier one it would otherwise be swallowed by. Same rule, same reason, as
// chatRoutes.
//
// GET /me — my wallet, my expense books, my invitations and my statement; protected.
router.get('/me', ctrl.getMyKhata);
// GET /me/colleagues — people I could share a book with (own company, minus anyone who has left); protected.
router.get('/me/colleagues', ctrl.listColleagues);
// GET /me/statement.pdf — my book (or every book) as a report PDF: all entries,
// day-wise or category-wise per ?report=, with the same filters as the screen;
// protected, own or shared books only (the employee id comes from the token).
router.get('/me/statement.pdf', ctrl.myStatementPdf);
// GET /me/report.xlsx — the same filtered rows as a spreadsheet; protected, no
// export grant needed (it is the caller's own book, not the company's ledger).
router.get('/me/report.xlsx', ctrl.myReportXlsx);
// GET /me/books/:id — one book (or the literal 'wallet') as a filtered, totalled entry feed; protected.
router.get('/me/books/:id', ctrl.getMyBook);
// POST /me/request — ask for an advance into my wallet (always parks); protected.
router.post('/me/request', ctrl.requestAdvance);
// POST /me/expense — log what I spent the advance on, against one of my books; protected + multer single 'receipt'.
router.post('/me/expense', receiptUpload.single('receipt'), ctrl.recordMyExpense);
// POST /me/refund — log money that came BACK into one of my books; protected + multer single 'receipt' (required).
router.post('/me/refund', receiptUpload.single('receipt'), ctrl.recordMyRefund);
// PUT /me/expenses/:id — correct an expense of mine the company has not confirmed yet; protected + multer single 'receipt'.
router.put('/me/expenses/:id', receiptUpload.single('receipt'), ctrl.updateMyExpense);
// POST /me/reimbursement — claim back what the company owes me, when I have spent past my advance; protected.
router.post('/me/reimbursement', ctrl.requestReimbursement);
// POST /me/settle — declare unspent cash returned to the company (always parks); protected + multer single 'receipt'.
router.post('/me/settle', receiptUpload.single('receipt'), ctrl.declareSettlement);
// POST /me/khatas — open an expense book on my own account; protected.
router.post('/me/khatas', ctrl.createMyKhata);

// ----- Sharing one of my books with a colleague -----
// The member routes go above the bare /me/khatas/:id so the longer pattern wins.
// POST /me/khatas/:id/members — invite colleagues onto a book I opened; protected, owner only.
router.post('/me/khatas/:id/members', ctrl.addKhataMembers);
// PATCH /me/khatas/:id/members/:userId — change what a collaborator may do; protected, owner only.
router.patch('/me/khatas/:id/members/:userId', ctrl.setKhataMemberRole);
// DELETE /me/khatas/:id/members/:userId — take somebody off a book, or leave one myself; protected, owner or self.
router.delete('/me/khatas/:id/members/:userId', ctrl.removeKhataMember);
// PUT /me/khatas/:id — rename or re-note a book I opened (closing stays the company's act); protected, owner only.
router.put('/me/khatas/:id', ctrl.updateMyKhata);
// PATCH /me/book-invites/:khataId — accept or decline an invitation to somebody else's book; protected.
router.patch('/me/book-invites/:khataId', ctrl.respondToBookInvite);

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
// report PDF: all entries, day-wise or category-wise per ?report=, with the
// bills embedded on ?bills=1; requires 'khata.manage'.
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
