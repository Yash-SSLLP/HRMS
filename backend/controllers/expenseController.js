/**
 * Expense controller — employee expense/reimbursement claims (Expense) with a
 * mandatory receipt. Employees submit and list claims; submitting notifies the
 * cashbook/expense reviewers. Reviewers act on them and, on payout, post a
 * matching cash-out entry into the cashbook (copying the receipt) and notify the
 * employee. Reimbursement posting is idempotent via the cashbookEntry link.
 */
const asyncHandler = require('express-async-handler');
const Expense = require('../models/Expense');
const khataSync = require('../services/khataSync');
const { EXPENSE_STATUS } = require('../models/Expense');
const AuditLog = require('../models/AuditLog');
const CashAccount = require('../models/CashAccount');
const CashbookEntry = require('../models/CashbookEntry');
const { recomputeBalance } = require('./cashbookController');
const storage = require('../services/storage');
const { hasPermission } = require('../middleware/authMiddleware');
const { scopeUserField, cannotSeeUser } = require('../utils/employeeScope');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');

const USER_FIELDS = 'firstName lastName email role';

/**
 * Attach each claim's status trail — who moved it, from what to what, and when.
 *
 * `reviewedBy` on the document only ever holds the LAST person to touch it, so
 * a claim approved by one reviewer and paid out by another loses the first
 * name. The auditStatus plugin on the Expense schema already records every
 * transition in AuditLog with the actor's name and role, so the trail is read
 * back from there — one indexed query for the whole page — and returned
 * alongside the claim. The names are snapshots taken at the time of the change,
 * which is what an audit trail should show even if someone is later renamed.
 *
 * @param {Array<import('mongoose').Document>} expenses - Expense docs.
 * @returns {Promise<Object[]>} Serialised claims, each with `statusHistory`
 *   oldest-first (the first entry is the submission).
 */
/**
 * Read the GPS fix a client sent with a claim.
 *
 * Best-effort: a refused permission or a phone with no fix leaves it out rather
 * than blocking the claim. Absent is a legitimate answer.
 * @param {object} body - req.body (multipart, so the values arrive as strings).
 * @returns {{lat: number, lng: number, accuracy?: number, at: Date}|undefined}
 */
function parseFiledLocation(body) {
  const lat = parseFloat(body?.latitude);
  const lng = parseFloat(body?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const accuracy = parseFloat(body?.accuracy);
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : undefined,
    at: new Date(),
  };
}

async function withStatusHistory(expenses, viewer) {
  if (!expenses.length) return [];

  const logs = await AuditLog.find({
    entity: 'Expense',
    field: 'status',
    entityId: { $in: expenses.map((e) => e._id) },
  })
    .sort({ at: 1 })
    .select('entityId fromStatus toStatus by byName byRole at')
    .lean();

  const trails = new Map();
  for (const log of logs) {
    const key = String(log.entityId);
    if (!trails.has(key)) trails.set(key, []);
    trails.get(key).push({
      from: log.fromStatus || null, // null on the submission row
      to: log.toStatus,
      by: log.by || null,
      byName: log.byName || null,
      byRole: log.byRole || null,
      at: log.at,
    });
  }

  // toJSON (not the raw doc) so the schema transform still hides the receipt's
  // storage path and adds hasReceipt — and strips the filing location, which
  // only a SuperAdmin may see. Putting it back HERE, from the raw document, is
  // the one place that is allowed to, and it is a deliberate act rather than
  // something a caller gets by default.
  const showLocation = viewer?.role === 'SuperAdmin';
  return expenses.map((e) => ({
    ...e.toJSON(),
    ...(showLocation && e.filedLocation?.lat != null
      ? { filedLocation: {
        lat: e.filedLocation.lat,
        lng: e.filedLocation.lng,
        accuracy: e.filedLocation.accuracy,
        at: e.filedLocation.at,
      } }
      : {}),
    statusHistory: trails.get(String(e._id)) || [],
  }));
}

// Tell the people who settle claims that a new one landed. Reimbursement is paid
// out of the cashbook, so cashbook-access holders are notified alongside the
// expense reviewers themselves.
async function notifyClaimReviewers(expense, submitter) {
  const who = `${submitter.firstName || ''} ${submitter.lastName || ''}`.trim() || 'An employee';
  // Walled to the claimant's company — reviewers of another company neither
  // settle nor should hear about this claim. (The submitter IS the claimant, so
  // their request-scoped company is the claim's company.)
  const reviewers = await scopeRecipientsToCompany(
    await usersHoldingAny('cashbook.manage', 'expenses.manage'),
    submitter.scopeCompanyId
  );
  await notifyMany(reviewers, {
    type: 'expense',
    audience: 'admin',
    title: 'New expense claim to review',
    body: `${who} submitted a ₹${expense.amount} ${expense.category} claim.`,
    link: '/admin/expenses',
  });
}

// Persist a receipt file (image/PDF) for an expense and stamp its receipt sub-doc.
async function attachReceipt(expense, file) {
  const saved = await storage.saveBuffer({
    buffer: file.buffer,
    ownerType: 'expense',
    ownerId: expense._id,
    originalName: file.originalname,
  });
  expense.receipt = {
    storagePath: saved.storagePath,
    name: file.originalname,
    sizeBytes: saved.sizeBytes,
    mime: file.mimetype,
  };
}

// ===== Employee self-service =====
/**
 * List the caller's own expense claims, newest first.
 * @route GET /api/expenses/me
 * @returns {{count: number, expenses: Object[]}}
 */
const listMyExpenses = asyncHandler(async (req, res) => {
  const expenses = await Expense.find({ employee: req.user._id })
    .sort({ createdAt: -1 })
    .populate('reviewedBy', USER_FIELDS);
  res.json({ count: expenses.length, expenses: await withStatusHistory(expenses) });
});

/**
 * Submit an expense claim with a required receipt (status Pending).
 * @route POST /api/expenses  (multipart: file + fields)
 * @param {number} req.body.amount - required, > 0
 * @param {string} req.body.expenseDate - required
 * @param {File} req.file - receipt image/PDF (required)
 * @param {string} [req.body.category]
 * @param {string} [req.body.description]
 * @param {string} [req.body.merchant]
 * @returns {{expense: Object}} (201)
 * @sideeffect notifies cashbook-access holders and expense reviewers
 */
const createExpense = asyncHandler(async (req, res) => {
  const { amount, expenseDate } = req.body;
  if (amount === undefined || amount === null || Number(amount) <= 0) {
    res.status(400);
    throw new Error('A positive amount is required');
  }
  if (!expenseDate) {
    res.status(400);
    throw new Error('expenseDate is required');
  }
  if (!req.file) {
    res.status(400);
    throw new Error('A receipt file (image or PDF) is required');
  }
  const { category, description, merchant } = req.body;
  const expense = await Expense.create({
    employee: req.user._id,
    category,
    amount,
    expenseDate,
    description,
    merchant,
    status: 'Pending',
    // Where the claim was filed from. SuperAdmin-visible only — the Expense
    // schema's toJSON strips it, and only the admin list puts it back.
    filedLocation: parseFiledLocation(req.body),
  });
  await attachReceipt(expense, req.file);
  await expense.save();

  // Best-effort: a notification failure must never fail the claim itself.
  notifyClaimReviewers(expense, req.user)
    .catch((err) => console.error('expense claim notify failed:', err.message));

  res.status(201).json({ expense });
});

/**
 * Stream an expense's receipt (owner or expenses.manage).
 * @route GET /api/expenses/:id/receipt
 * @param {string} req.params.id - expense id
 * @returns {binary} the receipt; 403 if unauthorized, 404 if missing
 */
// GET /api/expenses/:id/receipt — stream the receipt (owner or expenses.manage)
const downloadReceipt = asyncHandler(async (req, res) => {
  const expense = await Expense.findById(req.params.id).select('receipt employee');
  if (!expense || !expense.receipt?.storagePath) {
    res.status(404);
    throw new Error('Receipt not found');
  }
  const isOwner = String(expense.employee) === String(req.user._id);
  if (!isOwner && !hasPermission(req.user, 'expenses.manage')) {
    res.status(403);
    throw new Error('Not allowed');
  }
  // Company wall: a non-owner reviewer may only open receipts of claimants
  // within their own company scope (Expense.employee is a User id).
  if (!isOwner && (await cannotSeeUser(req, expense.employee))) {
    res.status(404);
    throw new Error('Receipt not found');
  }
  if (expense.receipt.mime) res.setHeader('Content-Type', expense.receipt.mime);
  if (!(await storage.streamTo(expense.receipt.storagePath, res))) {
    res.status(404);
    throw new Error('Receipt file missing');
  }
});

// ===== HR/Admin =====
/**
 * List all expense claims with optional status/category filters.
 * @route GET /api/expenses  (expenses.manage)
 * @param {string} [req.query.status]
 * @param {string} [req.query.category]
 * @returns {{count: number, expenses: Object[]}} with populated employee/reviewer
 *   and each claim's `statusHistory`
 */
const listExpenses = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  // Company wall: reviewers only see claims from employees of their own
  // company; SuperAdmin and unrestricted execs see everything.
  await scopeUserField(req, filter); // Expense.employee is a User id
  const expenses = await Expense.find(filter)
    .populate('employee', USER_FIELDS)
    .populate('reviewedBy', USER_FIELDS)
    .sort({ createdAt: -1 });
  // The viewer decides whether the filing locations travel — SuperAdmin only.
  res.json({ count: expenses.length, expenses: await withStatusHistory(expenses, req.user) });
});

/**
 * List active cashbook accounts a reviewer can pay a reimbursement from.
 * @route GET /api/expenses/accounts  (expenses.manage)
 * @returns {{count: number, accounts: Object[]}}
 */
// GET /api/expenses/accounts — active cashbook accounts to pay a reimbursement from.
// Exposed here (gated by expenses.manage) so a reviewer without cashbook.manage
// can still pick a paying account.
const listAccounts = asyncHandler(async (req, res) => {
  const accounts = await CashAccount.find({ isActive: true })
    .select('name type currentBalance currency')
    .sort({ name: 1 })
    .lean();
  res.json({ count: accounts.length, accounts });
});

// Post a cash-out ledger entry for a reimbursed expense and copy its receipt over.
async function postReimbursementToCashbook(expense, accountId, actor) {
  const acc = await CashAccount.findById(accountId);
  if (!acc) {
    const err = new Error('Account not found');
    err.statusCode = 404;
    throw err;
  }
  await expense.populate('employee', USER_FIELDS);
  const emp = expense.employee;
  const who = emp && emp.firstName ? `${emp.firstName} ${emp.lastName}`.trim() : 'Employee';

  const entry = await CashbookEntry.create({
    account: accountId,
    type: 'out',
    amount: expense.amount,
    date: expense.expenseDate || new Date(),
    category: 'Employee Reimbursement',
    paymentMode: 'Bank',
    description: `Expense reimbursement — ${expense.category}${expense.merchant ? ` (${expense.merchant})` : ''}`,
    party: who,
    // Cross-reference the claim's own code, so the ledger row and the expense
    // can be tied together from either side without an id lookup.
    referenceNo: expense.code || undefined,
    status: 'Approved',
    sourceExpense: expense._id,
    createdBy: actor._id,
  });

  // Copy the employee's receipt onto the ledger entry so cashbook-access users
  // can verify the payment via the existing /cashbook/entries/:id/receipt view.
  if (expense.receipt?.storagePath) {
    try {
      const buffer = await storage.readBuffer(expense.receipt.storagePath);
      const saved = await storage.saveBuffer({
        buffer,
        ownerType: 'cashbook',
        ownerId: entry._id,
        originalName: expense.receipt.name || 'receipt',
      });
      entry.attachment = {
        storagePath: saved.storagePath,
        name: expense.receipt.name,
        sizeBytes: saved.sizeBytes,
        mime: expense.receipt.mime,
      };
    } catch (err) {
      console.error('expense receipt copy failed:', err.message);
    }
  }

  const balance = await recomputeBalance(accountId);
  entry.balanceAfter = balance;
  await entry.save();
  return entry;
}

/**
 * Review an expense; a 'Reimbursed' status posts a cashbook cash-out entry once.
 * @route PATCH /api/expenses/:id/status  (expenses.manage)
 * @param {string} req.params.id - expense id
 * @param {string} req.body.status - one of EXPENSE_STATUS
 * @param {string} [req.body.reviewNote]
 * @param {string} [req.body.account] - paying cashbook account (required to reimburse)
 * @returns {{expense: Object}}
 * @sideeffect on first reimbursement posts a cashbook entry (with receipt copy) and notifies the employee
 */
const reviewExpense = asyncHandler(async (req, res) => {
  const { status, reviewNote, account } = req.body;
  if (!EXPENSE_STATUS.includes(status)) {
    res.status(400);
    throw new Error('Invalid status');
  }
  const expense = await Expense.findById(req.params.id);
  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
  }
  // Company wall: a reviewer may not act on another company's claim.
  if (await cannotSeeUser(req, expense.employee)) {
    res.status(404);
    throw new Error('Expense not found');
  }

  const wasReimbursed = expense.status === 'Reimbursed';
  // Grab the claimant's id up front: the cashbook post below populates
  // expense.employee into a full User doc, which is not a usable recipient.
  const employeeId = expense.employee;

  // On payout, post a cash-out entry to the cashbook (once — the link guards
  // against a second post on repeated "Mark Reimbursed" clicks).
  if (status === 'Reimbursed' && !expense.cashbookEntry) {
    if (!account) {
      res.status(400);
      throw new Error('Pick a cashbook account to pay this reimbursement from');
    }
    const entry = await postReimbursementToCashbook(expense, account, req.user);
    expense.cashbookEntry = entry._id;
  }

  expense.status = status;
  expense.reviewNote = reviewNote;
  expense.reviewedBy = req.user._id;
  expense.reviewedAt = new Date();
  await expense.save();

  // Mirror the claim into the employee's khata: approving it records that the
  // company owes them for their own spend, reimbursing it squares that off. The
  // pair nets to zero, and neither leg re-banks the cash — the cashbook entry
  // posted above is the single record of the money leaving. Best-effort.
  if (status === 'Approved') await khataSync.syncExpenseApproved(expense, req.user);
  if (status === 'Reimbursed' && !wasReimbursed) await khataSync.syncExpenseReimbursed(expense, req.user);
  // Send the reviewer back named, so the row the caller re-renders shows who
  // acted without waiting for the next list fetch.
  await expense.populate('reviewedBy', USER_FIELDS);

  // Tell the employee once the payout is actually persisted. Keyed off the
  // status TRANSITION rather than the cashbook post, so re-saving an already
  // reimbursed claim doesn't notify them twice.
  if (status === 'Reimbursed' && !wasReimbursed && employeeId) {
    notify({
      recipient: employeeId,
      type: 'expense',
      audience: 'employee',
      title: 'Expense reimbursed',
      body: `Your ₹${expense.amount} expense claim was reimbursed.`,
      link: '/employee/expenses',
    }).catch((err) => console.error('expense reimburse notify failed:', err.message));
  }

  res.json({ expense });
});

/**
 * Delete an expense claim and its stored receipt.
 * @route DELETE /api/expenses/:id  (expenses.manage)
 * @param {string} req.params.id - expense id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteExpense = asyncHandler(async (req, res) => {
  const expense = await Expense.findById(req.params.id);
  if (!expense) {
    res.status(404);
    throw new Error('Expense not found');
  }
  // Company wall: a reviewer may not delete another company's claim.
  if (await cannotSeeUser(req, expense.employee)) {
    res.status(404);
    throw new Error('Expense not found');
  }
  if (expense.receipt?.storagePath) {
    try { await storage.remove(expense.receipt.storagePath); } catch { /* ignore */ }
  }
  await expense.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listMyExpenses, createExpense, listExpenses, reviewExpense, deleteExpense,
  downloadReceipt, listAccounts, EXPENSE_STATUS,
};
