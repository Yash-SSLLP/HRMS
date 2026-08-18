/**
 * Employee-khata controller — the per-employee cash ledger between the company
 * and its staff.
 *
 * The cashbook answers "how much is in the tin?"; the khata answers "how much
 * is Rahul holding, and what has he settled?". Every balance-changing operation
 * is delegated to services/khataLedger.js, which owns the money rules and the
 * double-entry link into the cashbook. This file validates input, enforces who
 * may act on whom, and shapes responses — it never does balance arithmetic.
 *
 * Two audiences share the router:
 *   - every employee, for their own khata (view, request an advance, declare a
 *     return of cash);
 *   - khata operators, gated by the `khata.manage` capability AND, for anything
 *     that actually moves money, by being listed on the specific CashAccount.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const EmployeeKhata = require('../models/EmployeeKhata');
const KhataEntry = require('../models/KhataEntry');
const { ENTRY_TYPES, PAYMENT_MODES } = require('../models/KhataEntry');
const CashAccount = require('../models/CashAccount');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const storage = require('../services/storage');
const ledger = require('../services/khataLedger');
const { notify, notifyMany } = require('../services/notify');
const { hasPermission } = require('../middleware/authMiddleware');

const USER_FIELDS = 'firstName lastName email role photo';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const toNum = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const parseDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

/** Throw a client error with an HTTP status attached, for the error middleware. */
function bad(res, message, status = 400) {
  res.status(status);
  throw new Error(message);
}

/**
 * Format a balance the way the UI must speak about it — never "debit"/"credit".
 *
 * Positive means the employee owes the company, which from the company's side
 * reads "you will get". This mapping lives here so the web and the mobile app
 * cannot drift apart on the single most confusable thing in the module.
 * @param {number} balance - Signed balance, company's point of view.
 * @returns {{amount: number, direction: 'get'|'give'|'settled', label: string}}
 */
function describeBalance(balance) {
  const value = ledger.round2(balance || 0);
  if (value > 0) return { amount: value, direction: 'get', label: 'You will get' };
  if (value < 0) return { amount: Math.abs(value), direction: 'give', label: 'You will give' };
  return { amount: 0, direction: 'settled', label: 'Settled up' };
}

/** The same balance seen from the EMPLOYEE's side, for their own screens. */
function describeBalanceForEmployee(balance) {
  const value = ledger.round2(balance || 0);
  if (value > 0) return { amount: value, direction: 'owe', label: 'You owe the company' };
  if (value < 0) return { amount: Math.abs(value), direction: 'owed', label: 'The company owes you' };
  return { amount: 0, direction: 'settled', label: 'Settled up' };
}

/**
 * Allowlist mapper for a ledger entry. A field not named here never reaches a
 * client, however it happens to be stored.
 */
const publicEntry = (e) => ({
  _id: e._id,
  code: e.code,
  employee: e.employee && e.employee.firstName
    ? { _id: e.employee._id, name: `${e.employee.firstName} ${e.employee.lastName || ''}`.trim(), email: e.employee.email }
    : (e.employee?._id || e.employee || null),
  // Which of the employee's books this landed on — an entry is meaningless
  // without it once somebody holds more than one.
  khata: e.khata?._id || e.khata || null,
  khataName: e.khata?.name || undefined,
  direction: e.direction,
  type: e.type,
  amount: e.amount,
  // Pre-signed so a client never has to re-derive the convention.
  signedAmount: e.direction === 'to_employee' ? e.amount : -e.amount,
  date: e.date,
  purpose: e.purpose,
  category: e.category,
  paymentMode: e.paymentMode,
  referenceNo: e.referenceNo,
  status: e.status,
  affectsCompanyCash: e.affectsCompanyCash,
  cashAccount: e.cashAccount?._id || e.cashAccount || null,
  cashAccountName: e.cashAccount?.name || undefined,
  cashbookEntry: e.cashbookEntry || null,
  raisedByEmployee: e.raisedByEmployee,
  balanceAfter: e.balanceAfter,
  hasAttachment: !!e.attachment?.storagePath,
  reversalOf: e.reversalOf || null,
  reversedBy: e.reversedBy || null,
  reversalReason: e.reversalReason,
  reviewNote: e.reviewNote,
  reviewedAt: e.reviewedAt,
  reviewedBy: e.reviewedBy && e.reviewedBy.firstName
    ? { _id: e.reviewedBy._id, name: `${e.reviewedBy.firstName} ${e.reviewedBy.lastName || ''}`.trim() }
    : (e.reviewedBy?._id || e.reviewedBy || null),
  createdAt: e.createdAt,
});

/** Allowlist mapper for one khata. */
const publicKhata = (k) => ({
  _id: k._id,
  name: k.name,
  isDefault: k.isDefault,
  balance: k.balance,
  openingBalance: k.openingBalance,
  creditLimit: k.creditLimit,
  lastEntryAt: k.lastEntryAt,
  isActive: k.isActive,
  note: k.note,
  display: describeBalance(k.balance),
});

/**
 * Open a named khata, shared by the operator and self-service routes.
 *
 * Both paths need identical validation and identical duplicate handling, and
 * the duplicate handling is the fiddly part — see below.
 * @param {object} input
 * @param {string} input.employee - Whose book.
 * @param {string} input.name - What it is for.
 * @param {number} [input.creditLimit]
 * @param {string} [input.note]
 * @param {object} input.actor - The acting user.
 * @param {object} input.res - For setting the status before throwing.
 * @returns {Promise<object>} The new EmployeeKhata document.
 */
async function openKhata({ employee, name: rawName, creditLimit, note, actor, res }) {
  const name = String(rawName || '').trim();
  if (!name) bad(res, 'Give the khata a name — what is this money for?');
  if (name.length > 80) bad(res, 'That name is too long (80 characters max)');

  // Make sure their default exists first, so the FIRST book somebody opens by
  // hand does not accidentally become the fallback for self-service. This also
  // runs the one-time index self-heal (see khataLedger.ensureMultiKhataIndexes).
  await ledger.getOrCreateDefaultKhata(employee, actor);

  const limit = toNum(creditLimit);
  try {
    return await EmployeeKhata.create({
      employee,
      name,
      creditLimit: Number.isFinite(limit) && limit >= 0 ? ledger.round2(limit) : 0,
      note: note ? String(note).slice(0, 300) : undefined,
      createdBy: actor?._id,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;

    // A duplicate key here has TWO possible causes, and reporting the wrong one
    // sends people hunting for a name clash that does not exist:
    //   a) the intended one — this employee really does already have a book of
    //      this name, caught by the { employee, name } index;
    //   b) the obsolete single-field unique index on `employee`, left behind in
    //      databases that predate multi-khata. That one rejects the person's
    //      SECOND book whatever it is called.
    // So: look before speaking.
    const clash = await EmployeeKhata.findOne({ employee, name });
    if (clash) bad(res, `There is already a khata called "${name}" for this employee.`);

    bad(res, 'This database still has the old one-khata-per-employee index, so a second khata cannot be '
      + 'created. It should have been removed automatically — ask an administrator to run '
      + '"node scripts/migrateMultiKhata.js --apply" on the server.', 500);
  }
}

/**
 * Save an uploaded receipt onto an entry.
 * @param {object} entry - A saved KhataEntry document.
 * @param {object} [file] - Multer file, or undefined when none was sent.
 */
async function attachReceipt(entry, file) {
  if (!file) return;
  const saved = await storage.saveBuffer({
    buffer: file.buffer,
    ownerType: 'khata',
    ownerId: entry._id,
    originalName: file.originalname,
  });
  entry.attachment = {
    storagePath: saved.storagePath,
    name: file.originalname,
    sizeBytes: saved.sizeBytes,
    mime: file.mimetype,
  };
  await entry.save();
}

/**
 * Load a cash account and confirm the caller may pay employees out of it.
 * @param {object} user - The acting user.
 * @param {string} accountId
 * @param {object} res - For setting the status before throwing.
 * @returns {Promise<{account: object, rights: object}>}
 */
async function requireOperableAccount(user, accountId, res) {
  if (!isId(accountId)) bad(res, 'Choose which company account this money moves through.');
  const account = await CashAccount.findById(accountId);
  if (!account) bad(res, 'Cash account not found', 404);
  const rights = ledger.resolveDisburseRights(user, account);
  if (!rights.allowed) bad(res, rights.reason || 'You are not authorized to use this account', 403);
  return { account, rights };
}

/** Who should hear about a new khata request: SuperAdmins + Accounts Managers. */
async function khataApproverIds() {
  const users = await User.find({
    isActive: true,
    $or: [{ role: { $in: ['SuperAdmin', 'AccountsManager'] } }, { khataAccess: true }],
  }).select('_id');
  return users.map((u) => u._id);
}

/**
 * Attach employee-code/designation to a set of khatas for the admin list.
 * One query for the lot rather than one per row.
 * @param {Array<object>} khatas - Lean EmployeeKhata docs with `employee` populated.
 * @returns {Promise<Map<string, object>>} Keyed by user id.
 */
async function profilesFor(userIds) {
  const profiles = await EmployeeProfile.find({ user: { $in: userIds } })
    .select('user employeeCode designation department')
    .lean();
  return new Map(profiles.map((p) => [String(p.user), p]));
}

// ============================ Employee self-service ============================

/**
 * All of the caller's own khatas: one balance each, plus a combined position
 * and a single statement across the lot.
 *
 * The combined figure is what answers "am I square with the company?"; the
 * per-khata figures answer "which of my books is the money sitting on?". Both
 * are needed, so both are returned rather than making the client add them up.
 * @route GET /api/khata/me
 * @returns {{khatas: Object[], balance: object, total: number, entries: Object[]}}
 */
const getMyKhata = asyncHandler(async (req, res) => {
  // Opens their default on first visit, so the screen is never empty-handed.
  await ledger.getOrCreateDefaultKhata(req.user._id, req.user);
  const khatas = await ledger.listKhatasOf(req.user._id, true);

  const entries = await KhataEntry.find({ employee: req.user._id })
    .populate('cashAccount', 'name')
    .populate('khata', 'name')
    .sort({ date: -1, createdAt: -1 })
    .limit(400);

  // BOTH sides, not just the net. Somebody owing ₹5,000 on a site float while
  // the company owes them ₹2,000 for their own spend has both, and showing only
  // "₹3,000" hides the fact that they are owed anything at all.
  const totals = ledger.splitTotals(khatas);

  res.json({
    khatas: khatas.map((k) => ({
      ...publicKhata(k),
      // Worded from the employee's side: "you owe" / "the company owes you".
      display: describeBalanceForEmployee(k.balance),
    })),
    totals: {
      owe: totals.get,        // what the employee owes the company
      owed: totals.give,      // what the company owes the employee
      net: totals.net,
    },
    total: totals.net,
    balance: describeBalanceForEmployee(totals.net),
    count: entries.length,
    entries: entries.map(publicEntry),
  });
});

/**
 * Ask for a cash advance. Always parks as Pending — an employee can never
 * release company money to themselves, whatever permissions they hold.
 * @route POST /api/khata/me/request
 * @param {number} req.body.amount
 * @param {string} req.body.purpose - Required; what the money is for.
 * @returns {{entry: object, message: string}} 201
 */
const requestAdvance = asyncHandler(async (req, res) => {
  const amount = toNum(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) bad(res, 'Enter how much you need');
  const purpose = String(req.body.purpose || '').trim();
  if (!purpose) bad(res, 'Say what the advance is for');

  const { entry } = await ledger.postEntry({
    employee: req.user._id,
    // Which book they want it on. Omitted (or an unknown id) falls back to
    // their default; the ledger refuses one that is not theirs.
    khata: isId(req.body.khata) ? req.body.khata : undefined,
    direction: 'to_employee',
    type: 'advance',
    amount,
    purpose,
    category: req.body.category || 'Advance Request',
    paymentMode: req.body.paymentMode || 'Cash',
    date: parseDate(req.body.date) || new Date(),
    // The employee names no account and approves nothing: the reviewer decides
    // which book it comes out of, and only then does any cash move.
    autoApprove: false,
    raisedByEmployee: true,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  await notifyMany(await khataApproverIds(), {
    type: 'general',
    audience: 'admin',
    title: 'Cash advance requested',
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim() + ` requested ₹${amount.toLocaleString('en-IN')} — ${purpose}`,
    link: '/admin/khata',
  });

  res.status(201).json({ entry: publicEntry(entry), message: 'Request sent for approval' });
});

/**
 * Declare cash handed back to the company. Also parks as Pending — the company
 * confirms it actually received the money before the employee's balance drops.
 * @route POST /api/khata/me/settle
 * @param {number} req.body.amount
 * @param {file} [req.file] - Optional receipt (multer field 'receipt').
 * @returns {{entry: object, message: string}} 201
 */
const declareSettlement = asyncHandler(async (req, res) => {
  const amount = toNum(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) bad(res, 'Enter how much you are returning');

  const { entry } = await ledger.postEntry({
    employee: req.user._id,
    khata: isId(req.body.khata) ? req.body.khata : undefined,
    direction: 'from_employee',
    type: 'settlement',
    amount,
    purpose: String(req.body.purpose || 'Cash returned to company').trim(),
    category: req.body.category || 'Settlement',
    paymentMode: req.body.paymentMode || 'Cash',
    referenceNo: req.body.referenceNo,
    date: parseDate(req.body.date) || new Date(),
    autoApprove: false,
    raisedByEmployee: true,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  await attachReceipt(entry, req.file);

  await notifyMany(await khataApproverIds(), {
    type: 'general',
    audience: 'admin',
    title: 'Cash returned by employee',
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim() + ` says they returned ₹${amount.toLocaleString('en-IN')} — confirm to update their khata`,
    link: '/admin/khata',
  });

  res.status(201).json({ entry: publicEntry(entry), message: 'Sent for confirmation' });
});

// ============================ Operator: overview & lists ============================

/**
 * Headline figures for the khata dashboard.
 * @route GET /api/khata/overview  (khata.manage)
 * @returns {{totalReceivable: number, totalPayable: number, employeesOutstanding: number, pendingCount: number, accounts: Object[]}}
 */
const overview = asyncHandler(async (req, res) => {
  const khatas = await EmployeeKhata.find({ isActive: true }).select('balance employee').lean();

  // Split the signed balances into the two things a manager actually asks:
  // what is owed to us, and what we owe out. Both are summed PER BOOK, because
  // a person owing ₹5,000 on one float and owed ₹2,000 on another genuinely has
  // both — netting them to ₹3,000 receivable would hide the payable entirely.
  let totalReceivable = 0;
  let totalPayable = 0;
  // ...but the headcount is per PERSON, or somebody holding three floats would
  // be counted three times over.
  const outstandingPeople = new Set();
  for (const k of khatas) {
    if (k.balance > 0) { totalReceivable += k.balance; outstandingPeople.add(String(k.employee)); }
    else if (k.balance < 0) { totalPayable += Math.abs(k.balance); outstandingPeople.add(String(k.employee)); }
  }
  const employeesOutstanding = outstandingPeople.size;

  const pendingCount = await KhataEntry.countDocuments({ status: 'Pending' });

  res.json({
    totalReceivable: ledger.round2(totalReceivable),
    totalPayable: ledger.round2(totalPayable),
    net: ledger.round2(totalReceivable - totalPayable),
    employeesOutstanding,
    activeKhatas: khatas.length,
    peopleWithKhatas: new Set(khatas.map((k) => String(k.employee))).size,
    pendingCount,
    // Only the accounts this operator may actually pay from.
    accounts: await ledger.listOperableAccounts(req.user),
  });
});

/**
 * The cash accounts the caller may pay employees from, with their limits.
 * Backs the account picker, so a form can only ever offer a usable account.
 * @route GET /api/khata/accounts  (khata.manage)
 * @returns {{accounts: Object[]}}
 */
const listMyAccounts = asyncHandler(async (req, res) => {
  res.json({ accounts: await ledger.listOperableAccounts(req.user) });
});

/**
 * Every employee khata, for the "who owes what" list.
 * @route GET /api/khata/employees  (khata.manage)
 * @param {string} [req.query.q] - Name/email search.
 * @param {string} [req.query.filter] - 'outstanding' | 'payable' | 'settled' | 'all'.
 * @returns {{count: number, khatas: Object[]}}
 */
const listKhatas = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query.includeArchived !== 'true') query.isActive = true;

  let khatas = await EmployeeKhata.find(query)
    .populate('employee', USER_FIELDS)
    .sort({ isDefault: -1, name: 1 })
    .lean();

  // Drop khatas whose user was deleted, so the list never shows an orphan row.
  khatas = khatas.filter((k) => k.employee);

  const profiles = await profilesFor(khatas.map((k) => k.employee._id));

  // ONE ROW PER PERSON, not per khata. Somebody carrying a site float, a
  // vehicle float and a salary advance is still one person to chase, and three
  // separate rows for them would bury that. Each row carries the breakdown so
  // the list can expand into "which book is it sitting on?".
  const byEmployee = new Map();
  for (const k of khatas) {
    const id = String(k.employee._id);
    if (!byEmployee.has(id)) {
      const profile = profiles.get(id);
      byEmployee.set(id, {
        employee: {
          _id: k.employee._id,
          name: `${k.employee.firstName} ${k.employee.lastName || ''}`.trim(),
          email: k.employee.email,
          photo: k.employee.photo || null,
          employeeCode: profile?.employeeCode,
          designation: profile?.designation,
          department: profile?.department,
        },
        total: 0,
        lastEntryAt: null,
        khatas: [],
      });
    }
    const row = byEmployee.get(id);
    row.total = ledger.round2(row.total + (k.balance || 0));
    // The person's staleness is their MOST RECENT movement on any book: someone
    // settling one khata weekly is not stale because another sat untouched.
    if (k.lastEntryAt && (!row.lastEntryAt || k.lastEntryAt > row.lastEntryAt)) {
      row.lastEntryAt = k.lastEntryAt;
    }
    row.khatas.push({
      _id: k._id,
      name: k.name,
      isDefault: k.isDefault,
      balance: k.balance,
      display: describeBalance(k.balance),
      creditLimit: k.creditLimit,
      lastEntryAt: k.lastEntryAt,
      isActive: k.isActive,
    });
  }

  let rows = [...byEmployee.values()];

  // Filtering and searching happen on the PERSON's combined position, so
  // "owes us" means the person is net owing — not that one of their books is.
  const filter = req.query.filter || 'all';
  if (filter === 'outstanding') rows = rows.filter((r) => r.total > 0);
  else if (filter === 'payable') rows = rows.filter((r) => r.total < 0);
  else if (filter === 'settled') rows = rows.filter((r) => r.total === 0);

  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.employee.name.toLowerCase().includes(q)
      || String(r.employee.email || '').toLowerCase().includes(q)
      || String(r.employee.employeeCode || '').toLowerCase().includes(q)
      // Searching a book name is how you find "who is holding the Site A float".
      || r.khatas.some((k) => k.name.toLowerCase().includes(q)));
  }

  rows.sort((a, b) => b.total - a.total);
  rows.forEach((r) => {
    r.display = describeBalance(r.total);
    // Both sides for this person, so a row can show "owes 5,000 / owed 2,000"
    // rather than collapsing to a single misleading 3,000.
    r.totals = ledger.splitTotals(r.khatas);
  });

  res.json({ count: rows.length, rows });
});

/**
 * One employee's khata with their full statement.
 * @route GET /api/khata/employees/:employeeId  (khata.manage)
 * @returns {{khata: object, balance: object, entries: Object[]}}
 */
const getKhata = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  if (!isId(employeeId)) bad(res, 'Invalid employee', 400);

  const employee = await User.findById(employeeId).select(USER_FIELDS);
  if (!employee) bad(res, 'Employee not found', 404);

  // Opens their default on first view, so a person with no books yet still has
  // somewhere for the first advance to land.
  await ledger.getOrCreateDefaultKhata(employeeId, req.user);
  const khatas = await ledger.listKhatasOf(employeeId, true);

  const profile = await EmployeeProfile.findOne({ user: employeeId })
    .select('employeeCode designation department').lean();

  const filter = { employee: employeeId };
  // Narrow to a single book when one is named; otherwise show everything they
  // hold, which is the view that answers "what is going on with this person?".
  if (isId(req.query.khata)) filter.khata = req.query.khata;

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) { to.setHours(23, 59, 59, 999); filter.date.$lte = to; }
  }
  if (req.query.status) filter.status = req.query.status;

  const entries = await KhataEntry.find(filter)
    .populate('cashAccount', 'name')
    .populate('khata', 'name')
    .populate('reviewedBy', 'firstName lastName')
    .sort({ date: -1, createdAt: -1 })
    .limit(1000);

  const totals = ledger.splitTotals(khatas);

  res.json({
    khatas: khatas.map(publicKhata),
    // Both sides in full — see splitTotals.
    totals,
    employee: {
      _id: employee._id,
      name: `${employee.firstName} ${employee.lastName || ''}`.trim(),
      email: employee.email,
      photo: employee.photo || null,
      employeeCode: profile?.employeeCode,
      designation: profile?.designation,
      department: profile?.department,
    },
    total: totals.net,
    balance: describeBalance(totals.net),
    count: entries.length,
    entries: entries.map(publicEntry),
  });
});

/**
 * Open a new khata for an employee.
 *
 * This is how a second (or fifth) book gets created — "Site A — materials",
 * "Vehicle & fuel". Any khata operator can open one, because deciding that a
 * float needs its own book is part of running the cash, not an admin act. What
 * they still cannot do is put money on it beyond their account limits.
 * @route POST /api/khata/khatas  (khata.manage)
 * @param {string} req.body.employee - Whose book.
 * @param {string} req.body.name - What it is for.
 * @param {number} [req.body.creditLimit]
 * @param {string} [req.body.note]
 * @returns {{khata: object, message: string}} 201
 */
const createKhata = asyncHandler(async (req, res) => {
  const { employee } = req.body;
  if (!isId(employee)) bad(res, 'Choose an employee');

  const target = await User.findById(employee).select('firstName lastName isActive');
  if (!target) bad(res, 'Employee not found', 404);
  if (!target.isActive) bad(res, 'That account is deactivated and cannot hold company cash');

  const khata = await openKhata({
    employee,
    name: req.body.name,
    creditLimit: req.body.creditLimit,
    note: req.body.note,
    actor: req.user,
    res,
  });

  // Tell the employee a book was opened in their name — they can request
  // against it, so they should not first meet it as a surprise entry.
  await notify({
    recipient: employee,
    type: 'general',
    audience: 'employee',
    title: 'New khata opened',
    body: `A khata called "${khata.name}" was opened for you. You can request money against it from My Khata.`,
    link: '/employee/khata',
  });

  res.status(201).json({ khata: publicKhata(khata), message: `"${khata.name}" opened.` });
});

/**
 * Open a khata on your own account.
 *
 * An employee taking on a new job — a second site, a vehicle — knows they need
 * a separate book before finance does, and making them wait on an operator just
 * to name one is friction with no safety value: opening a book moves no money.
 * They can name it and use it; only an operator can put cash on it, set its
 * limit, or make it the default.
 * @route POST /api/khata/me/khatas
 * @param {string} req.body.name - What the book is for.
 * @param {string} [req.body.note]
 * @returns {{khata: object, message: string}} 201
 */
const createMyKhata = asyncHandler(async (req, res) => {
  // A soft cap. Opening a book is harmless, but a runaway loop or a bored
  // tester should not be able to fill the outstanding list with hundreds.
  const existing = await EmployeeKhata.countDocuments({ employee: req.user._id });
  if (existing >= 25) {
    bad(res, 'You already have 25 khatas. Close one you have finished with before opening another.');
  }

  const khata = await openKhata({
    employee: req.user._id,
    name: req.body.name,
    // Deliberately NOT taken from the request: a spending limit is the
    // company's decision about how much cash this person may hold, and letting
    // them set their own would make it meaningless. An operator sets it after.
    creditLimit: 0,
    note: req.body.note,
    actor: req.user,
    res,
  });

  await notifyMany(await khataApproverIds(), {
    type: 'general',
    audience: 'admin',
    title: 'Employee opened a khata',
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim()
      + ` opened a khata called "${khata.name}". Set a limit on it if it needs one.`,
    link: '/admin/khata',
  });

  res.status(201).json({ khata: publicKhata(khata), message: `"${khata.name}" opened.` });
});

/**
 * Employees available to open a khata for — the give-advance picker.
 *
 * Exposed here rather than reusing /api/employees because a khata operator is
 * often not an HR admin and will not hold `employees.manage`. Deliberately thin:
 * name, code and designation only, never salary or personal data.
 * @route GET /api/khata/employee-options  (khata.manage)
 * @returns {{count: number, employees: Object[]}}
 */
const employeeOptions = asyncHandler(async (req, res) => {
  const users = await User.find({ isActive: true, role: { $nin: ['CEO', 'MD'] } })
    .select('firstName lastName email photo')
    .sort({ firstName: 1 })
    .lean();

  const profiles = await profilesFor(users.map((u) => u._id));
  // A person's figure here is the sum across every book they hold, since the
  // picker is answering "how exposed are we to this person already?".
  const khatas = await EmployeeKhata.find({ employee: { $in: users.map((u) => u._id) } })
    .select('employee balance').lean();
  const balances = new Map();
  for (const k of khatas) {
    const id = String(k.employee);
    balances.set(id, ledger.round2((balances.get(id) || 0) + (k.balance || 0)));
  }

  res.json({
    count: users.length,
    employees: users.map((u) => {
      const profile = profiles.get(String(u._id));
      return {
        _id: u._id,
        name: `${u.firstName} ${u.lastName || ''}`.trim(),
        email: u.email,
        photo: u.photo || null,
        employeeCode: profile?.employeeCode,
        designation: profile?.designation,
        department: profile?.department,
        // So the picker can warn "already holds ₹4,000" before a second advance.
        balance: balances.get(String(u._id)) || 0,
      };
    }),
  });
});

// ============================ Operator: posting money ============================

/**
 * Post a khata entry — give an advance, or record cash taken back.
 *
 * Whether the money moves now or parks for approval is decided by the operator's
 * own limit on the chosen account (CashAccount.operators), never by anything the
 * client sends. An operator can therefore always ask, and never over-release.
 * @route POST /api/khata/entries  (khata.manage)
 * @param {string} req.body.employee - Whose khata.
 * @param {'to_employee'|'from_employee'} req.body.direction
 * @param {number} req.body.amount
 * @param {string} req.body.cashAccount - Which company book the cash moves through.
 * @param {boolean} [req.body.affectsCompanyCash=true] - False for an employee's own spend.
 * @param {file} [req.file] - Optional receipt (multer field 'receipt').
 * @returns {{entry: object, khata: object, posted: boolean, message: string}} 201
 */
const createEntry = asyncHandler(async (req, res) => {
  const { employee, direction } = req.body;
  if (!isId(employee)) bad(res, 'Choose an employee');
  if (!['to_employee', 'from_employee'].includes(direction)) bad(res, 'Say which way the money moved');

  const amount = toNum(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) bad(res, 'Enter an amount greater than zero');

  const target = await User.findById(employee).select(USER_FIELDS);
  if (!target) bad(res, 'Employee not found', 404);

  const type = ENTRY_TYPES.includes(req.body.type)
    ? req.body.type
    : (direction === 'to_employee' ? 'advance' : 'settlement');
  // A reversal row is only ever written by the reverse endpoint, so that the
  // original it cancels is always updated in the same breath.
  if (type === 'reversal') bad(res, 'Use the reverse action to cancel an entry');

  // An employee's own spend, or a payroll recovery, moves no company cash and so
  // needs no account and no operator rights — it only shifts what is owed.
  const affectsCompanyCash = String(req.body.affectsCompanyCash) !== 'false';

  let autoApprove = true;
  let accountId;
  if (affectsCompanyCash) {
    const { account, rights } = await requireOperableAccount(req.user, req.body.cashAccount, res);
    accountId = account._id;
    // The threshold rule: within their limit it posts now; above it, it parks.
    autoApprove = ledger.willAutoApprove(rights, amount);
  }

  const paymentMode = PAYMENT_MODES.includes(req.body.paymentMode) ? req.body.paymentMode : 'Cash';

  const { entry, khata, duplicate } = await ledger.postEntry({
    employee,
    // Which of this employee's books the money lands on. The ledger refuses a
    // khata belonging to somebody else, or one that has been closed; omitting
    // it falls back to their default.
    khata: isId(req.body.khata) ? req.body.khata : undefined,
    direction,
    type,
    amount,
    date: parseDate(req.body.date) || new Date(),
    purpose: String(req.body.purpose || '').trim(),
    category: req.body.category,
    paymentMode,
    referenceNo: req.body.referenceNo,
    cashAccount: accountId,
    affectsCompanyCash,
    autoApprove,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  if (duplicate) {
    return res.status(200).json({
      entry: publicEntry(entry),
      khata: { _id: khata._id, name: khata.name, balance: khata.balance, display: describeBalance(khata.balance) },
      posted: entry.status === 'Approved',
      message: 'Already recorded — this entry was submitted before.',
    });
  }

  await attachReceipt(entry, req.file);

  if (autoApprove) {
    // Tell the employee their own khata moved, in their own words.
    await notify({
      recipient: employee,
      type: 'general',
      audience: 'employee',
      title: direction === 'to_employee' ? 'Cash advance received' : 'Cash return recorded',
      body: direction === 'to_employee'
        ? `₹${amount.toLocaleString('en-IN')} was given to you on "${khata.name}". `
          + `That khata now stands at ₹${Math.abs(khata.balance).toLocaleString('en-IN')}.`
        : `₹${amount.toLocaleString('en-IN')} was recorded against your "${khata.name}" khata.`,
      link: '/employee/khata',
    });
  } else {
    await notifyMany(await khataApproverIds(), {
      type: 'general',
      audience: 'admin',
      title: 'Khata entry needs approval',
      body: `₹${amount.toLocaleString('en-IN')} for ${target.firstName} is above the operator's limit and is awaiting approval`,
      link: '/admin/khata',
    });
  }

  res.status(201).json({
    entry: publicEntry(entry),
    khata: { _id: khata._id, name: khata.name, balance: khata.balance, display: describeBalance(khata.balance) },
    posted: autoApprove,
    message: autoApprove
      ? 'Recorded — the money has moved.'
      : 'Above your limit, so it has been sent for approval. No cash has moved yet.',
  });
});

/**
 * List ledger entries across all employees, for the operator's ledger tab.
 * @route GET /api/khata/entries  (khata.manage)
 * @param {string} [req.query.status] [req.query.employee] [req.query.type] [req.query.from] [req.query.to]
 * @returns {{count: number, entries: Object[]}}
 */
const listEntries = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (isId(req.query.employee)) filter.employee = req.query.employee;
  if (req.query.type && ENTRY_TYPES.includes(req.query.type)) filter.type = req.query.type;
  if (isId(req.query.cashAccount)) filter.cashAccount = req.query.cashAccount;
  if (isId(req.query.khata)) filter.khata = req.query.khata;

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) { to.setHours(23, 59, 59, 999); filter.date.$lte = to; }
  }

  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const entries = await KhataEntry.find(filter)
    .populate('employee', USER_FIELDS)
    .populate('khata', 'name')
    .populate('cashAccount', 'name')
    .populate('reviewedBy', 'firstName lastName')
    .sort({ date: -1, createdAt: -1 })
    .limit(limit);

  res.json({ count: entries.length, entries: entries.map(publicEntry) });
});

/**
 * Everything waiting on a decision — the khata approvals queue.
 * @route GET /api/khata/pending  (khata.manage)
 * @returns {{count: number, entries: Object[]}}
 */
const listPending = asyncHandler(async (req, res) => {
  const entries = await KhataEntry.find({ status: 'Pending' })
    .populate('employee', USER_FIELDS)
    .populate('khata', 'name')
    .populate('cashAccount', 'name')
    .sort({ createdAt: 1 });
  res.json({ count: entries.length, entries: entries.map(publicEntry) });
});

/**
 * Approve a parked entry — the cash moves now.
 *
 * Approving requires more than the module capability: the approver must be a
 * SuperAdmin or an operator carrying `canApprove` on the account being paid
 * from, so releasing your own parked payout is not the same grant as recording
 * it. The account may be chosen here if the requester never named one.
 * @route PATCH /api/khata/entries/:id/approve  (khata.manage)
 * @param {string} [req.body.cashAccount] - Which book to pay from.
 * @param {string} [req.body.note]
 * @returns {{entry: object, khata: object, message: string}}
 */
const approveEntry = asyncHandler(async (req, res) => {
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'Entry not found', 404);
  if (entry.status !== 'Pending') bad(res, `This entry is already ${entry.status.toLowerCase()}.`);

  const accountId = req.body.cashAccount || entry.cashAccount;
  if (entry.affectsCompanyCash) {
    const { rights } = await requireOperableAccount(req.user, accountId, res);
    if (!rights.canApprove) {
      bad(res, 'You can record entries on this account but not approve them. Ask a Super Admin.', 403);
    }
  } else if (req.user.role !== 'SuperAdmin' && !hasPermission(req.user, 'khata.manage')) {
    bad(res, 'You do not have permission to approve khata entries', 403);
  }

  const { entry: saved, khata } = await ledger.approveEntry(entry, req.user, {
    cashAccount: accountId,
    note: req.body.note,
  });

  await notify({
    recipient: saved.employee,
    type: 'general',
    audience: 'employee',
    title: 'Khata entry approved',
    body: `₹${saved.amount.toLocaleString('en-IN')} has been posted to your khata (${saved.code || 'entry'}).`,
    link: '/employee/khata',
  });

  res.json({
    entry: publicEntry(saved),
    khata: { _id: khata._id, name: khata.name, balance: khata.balance, display: describeBalance(khata.balance) },
    message: 'Approved — the money has moved.',
  });
});

/**
 * Decline a parked entry. Nothing moves and the balance is untouched.
 * @route PATCH /api/khata/entries/:id/reject  (khata.manage)
 * @param {string} [req.body.note] - Shown to the employee.
 * @returns {{entry: object, message: string}}
 */
const rejectEntry = asyncHandler(async (req, res) => {
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'Entry not found', 404);

  const saved = await ledger.rejectEntry(entry, req.user, req.body.note);

  await notify({
    recipient: saved.employee,
    type: 'general',
    audience: 'employee',
    title: 'Khata request declined',
    body: req.body.note
      ? `Your ₹${saved.amount.toLocaleString('en-IN')} request was declined: ${req.body.note}`
      : `Your ₹${saved.amount.toLocaleString('en-IN')} request was declined.`,
    link: '/employee/khata',
  });

  res.json({ entry: publicEntry(saved), message: 'Declined' });
});

/**
 * Correct a posted entry by reversing it. Nothing is ever deleted.
 *
 * Restricted to SuperAdmins and operators who may approve on that account:
 * unwinding money that has already moved is a heavier act than paying it out.
 * @route POST /api/khata/entries/:id/reverse  (khata.manage)
 * @param {string} req.body.reason - Required; stored permanently on both rows.
 * @returns {{original: object, reversal: object, khata: object, message: string}}
 */
const reverseEntry = asyncHandler(async (req, res) => {
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'Entry not found', 404);

  if (req.user.role !== 'SuperAdmin') {
    if (entry.affectsCompanyCash && entry.cashAccount) {
      const { rights } = await requireOperableAccount(req.user, entry.cashAccount, res);
      if (!rights.canApprove) bad(res, 'Only an approver on this account can reverse a posted entry.', 403);
    } else {
      bad(res, 'Only a Super Admin can reverse this entry.', 403);
    }
  }

  const { original, reversal, khata } = await ledger.reverseEntry(entry, req.user, req.body.reason);

  await notify({
    recipient: original.employee,
    type: 'general',
    audience: 'employee',
    title: 'Khata entry reversed',
    body: `${original.code || 'An entry'} of ₹${original.amount.toLocaleString('en-IN')} was reversed: ${req.body.reason}`,
    link: '/employee/khata',
  });

  res.json({
    original: publicEntry(original),
    reversal: publicEntry(reversal),
    khata: { _id: khata._id, name: khata.name, balance: khata.balance, display: describeBalance(khata.balance) },
    message: 'Reversed. Both entries stay on the record.',
  });
});

// ============================ Khata settings ============================

/**
 * Set an employee's khata limit, opening balance, note, or archive it.
 *
 * The opening balance is SuperAdmin-only: it is the one number that changes the
 * balance without any ledger row behind it, so it must not be reachable by an
 * ordinary operator.
 * @route PUT /api/khata/employees/:employeeId  (khata.manage)
 * @returns {{khata: object, message: string}}
 */
const updateKhataSettings = asyncHandler(async (req, res) => {
  const { khataId } = req.params;
  if (!isId(khataId)) bad(res, 'Invalid khata');

  const khata = await EmployeeKhata.findById(khataId);
  if (!khata) bad(res, 'Khata not found', 404);

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) bad(res, 'A khata needs a name');
    if (name.length > 80) bad(res, 'That name is too long (80 characters max)');
    khata.name = name;
  }
  if (req.body.creditLimit !== undefined) {
    const limit = toNum(req.body.creditLimit);
    if (!Number.isFinite(limit) || limit < 0) bad(res, 'The khata limit must be zero or more');
    khata.creditLimit = ledger.round2(limit);
  }
  if (req.body.note !== undefined) khata.note = String(req.body.note).slice(0, 300);

  if (req.body.isActive !== undefined) {
    const nextActive = req.body.isActive === true || req.body.isActive === 'true';
    // A book still carrying money cannot be closed: closing it would hide a
    // live balance from the outstanding list and quietly write off whatever is
    // owed. Settle it first, then close it.
    if (!nextActive && khata.balance !== 0) {
      bad(res, `"${khata.name}" still has a balance of ₹${Math.abs(khata.balance).toLocaleString('en-IN')}. `
        + 'Settle it before closing the khata.');
    }
    // Likewise the fallback book has to stay open, or self-service has nowhere
    // to put a request from someone with no other khata.
    if (!nextActive && khata.isDefault) {
      bad(res, 'This is the default khata and cannot be closed. Make another one the default first.');
    }
    khata.isActive = nextActive;
  }

  // Exactly one default per employee, so promoting one demotes the rest.
  if (req.body.isDefault === true || req.body.isDefault === 'true') {
    if (!khata.isActive) bad(res, 'A closed khata cannot be the default.');
    await EmployeeKhata.updateMany(
      { employee: khata.employee, _id: { $ne: khata._id } },
      { $set: { isDefault: false } }
    );
    khata.isDefault = true;
  }

  let recompute = false;
  if (req.body.openingBalance !== undefined) {
    if (req.user.role !== 'SuperAdmin') {
      bad(res, 'Only a Super Admin can set an opening balance — it moves the balance with no ledger entry behind it.', 403);
    }
    const opening = toNum(req.body.openingBalance);
    if (!Number.isFinite(opening)) bad(res, 'Enter a valid opening balance');
    khata.openingBalance = ledger.round2(opening);
    recompute = true;
  }

  await khata.save();
  if (recompute) await ledger.recomputeKhataBalance(khata._id);

  const fresh = await EmployeeKhata.findById(khata._id);
  res.json({
    khata: {
      _id: fresh._id,
      name: fresh.name,
      isDefault: fresh.isDefault,
      balance: fresh.balance,
      openingBalance: fresh.openingBalance,
      creditLimit: fresh.creditLimit,
      isActive: fresh.isActive,
      note: fresh.note,
      display: describeBalance(fresh.balance),
    },
    display: describeBalance(fresh.balance),
    message: 'Saved',
  });
});

/**
 * Rebuild an employee's balance from their ledger.
 *
 * The balance is already recomputed after every change, so this is a repair
 * tool rather than part of any normal flow — for use after a direct database
 * edit or a restored backup.
 * @route POST /api/khata/employees/:employeeId/recompute  (SuperAdmin)
 * @returns {{balance: number, message: string}}
 */
const recomputeKhata = asyncHandler(async (req, res) => {
  if (!isId(req.params.khataId)) bad(res, 'Invalid khata');
  const khata = await EmployeeKhata.findById(req.params.khataId);
  if (!khata) bad(res, 'Khata not found', 404);
  const balance = await ledger.recomputeKhataBalance(khata._id);
  res.json({ balance, display: describeBalance(balance), message: `"${khata.name}" rebuilt from its ledger` });
});

// ============================ Account operators ============================

/**
 * Who may pay employees out of each cash account.
 * @route GET /api/khata/accounts/:id/operators  (SuperAdmin)
 * @returns {{account: object, operators: Object[]}}
 */
const listOperators = asyncHandler(async (req, res) => {
  const account = await CashAccount.findById(req.params.id).populate('operators.user', USER_FIELDS);
  if (!account) bad(res, 'Cash account not found', 404);

  res.json({
    account: { _id: account._id, name: account.name, type: account.type, currentBalance: account.currentBalance },
    operators: (account.operators || []).filter((o) => o.user).map((o) => ({
      user: {
        _id: o.user._id,
        name: `${o.user.firstName} ${o.user.lastName || ''}`.trim(),
        email: o.user.email,
        role: o.user.role,
      },
      canDisburse: o.canDisburse,
      canApprove: o.canApprove,
      maxPerTransaction: o.maxPerTransaction,
      addedAt: o.addedAt,
    })),
  });
});

/**
 * Replace an account's operator list.
 *
 * SuperAdmin only, and deliberately a whole-list replace rather than add/remove
 * calls: who can spend the company's money is reviewed as a set, and a partial
 * update makes it easy to leave someone behind by accident.
 * @route PUT /api/khata/accounts/:id/operators  (SuperAdmin)
 * @param {Array} req.body.operators - [{user, canDisburse, canApprove, maxPerTransaction}]
 * @returns {{operators: Object[], message: string}}
 */
const setOperators = asyncHandler(async (req, res) => {
  const account = await CashAccount.findById(req.params.id);
  if (!account) bad(res, 'Cash account not found', 404);

  const incoming = Array.isArray(req.body.operators) ? req.body.operators : [];
  const seen = new Set();
  const operators = [];

  for (const raw of incoming) {
    const userId = raw.user?._id || raw.user;
    if (!isId(userId)) bad(res, 'One of the operators is not a valid user');
    if (seen.has(String(userId))) continue; // the same person listed twice
    seen.add(String(userId));

    const user = await User.findById(userId).select('_id isActive');
    if (!user) bad(res, 'One of the operators no longer exists');
    if (!user.isActive) bad(res, 'A deactivated account cannot be given cash access');

    const max = toNum(raw.maxPerTransaction);
    operators.push({
      user: userId,
      canDisburse: raw.canDisburse !== false,
      canApprove: raw.canApprove === true,
      maxPerTransaction: Number.isFinite(max) && max >= 0 ? ledger.round2(max) : 0,
      addedBy: req.user._id,
      addedAt: new Date(),
    });
  }

  account.operators = operators;
  await account.save();

  // Tell people they can now spend company money — this is not a change anyone
  // should first discover by trying it.
  await notifyMany(operators.map((o) => o.user), {
    type: 'general',
    audience: 'all',
    title: 'Cash account access granted',
    body: `You can now record employee cash entries against "${account.name}".`,
    link: '/employee/khata-manage',
  });

  res.json({ count: operators.length, message: 'Operators updated' });
});

// ============================ Reports ============================

/**
 * Outstanding balances, oldest-first, with an ageing band per employee.
 *
 * The question this answers is not "how much is out?" but "who has been sitting
 * on it, and for how long?" — which is what actually drives a collection chase.
 * Ageing is measured from the last movement on the khata: somebody settling
 * weekly is not stale even if their balance is large.
 * @route GET /api/khata/reports/outstanding  (khata.manage)
 * @param {string} [req.query.minAmount] - Hide balances below this.
 * @returns {{count: number, total: number, buckets: object, rows: Object[]}}
 */
const outstandingReport = asyncHandler(async (req, res) => {
  const minAmount = Number(req.query.minAmount) || 0;

  const khatas = await EmployeeKhata.find({ isActive: true, balance: { $gt: minAmount } })
    .populate('employee', USER_FIELDS)
    .sort({ lastEntryAt: 1 })
    .lean();

  const rows = khatas.filter((k) => k.employee);
  const profiles = await profilesFor(rows.map((k) => k.employee._id));

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = { current: 0, days30: 0, days60: 0, days90plus: 0 };

  const out = rows.map((k) => {
    // No movement at all means the opening balance has never been touched, which
    // is the stalest case there is — treat it as the oldest band, not the newest.
    const days = k.lastEntryAt ? Math.floor((now - new Date(k.lastEntryAt).getTime()) / DAY) : 9999;
    const band = days <= 30 ? 'current' : days <= 60 ? 'days30' : days <= 90 ? 'days60' : 'days90plus';
    buckets[band] = ledger.round2(buckets[band] + k.balance);

    const profile = profiles.get(String(k.employee._id));
    return {
      employee: {
        _id: k.employee._id,
        name: `${k.employee.firstName} ${k.employee.lastName || ''}`.trim(),
        email: k.employee.email,
        employeeCode: profile?.employeeCode,
        designation: profile?.designation,
        department: profile?.department,
      },
      // One row per BOOK here, unlike the people list — a collection chase is
      // per float ("the Site A money is 90 days old"), not per person.
      khata: { _id: k._id, name: k.name },
      balance: k.balance,
      creditLimit: k.creditLimit,
      lastEntryAt: k.lastEntryAt,
      daysSinceLastEntry: k.lastEntryAt ? days : null,
      ageing: band,
    };
  });

  res.json({
    count: out.length,
    total: ledger.round2(out.reduce((a, r) => a + r.balance, 0)),
    buckets,
    rows: out,
  });
});

/**
 * Nudge employees who are holding company cash.
 *
 * Sends one notification per outstanding employee, worded from their side.
 * Deliberately a manual action rather than a cron: a reminder is a relationship
 * event, and finance should choose when to send it, not have it fire nightly.
 * @route POST /api/khata/reports/remind  (khata.manage)
 * @param {string[]} [req.body.employees] - Specific people; omit for everyone outstanding.
 * @param {number} [req.body.minAmount=1] - Skip trivial balances.
 * @returns {{sent: number, message: string}}
 */
const sendSettleReminders = asyncHandler(async (req, res) => {
  const minAmount = Number(req.body.minAmount) > 0 ? Number(req.body.minAmount) : 1;
  const filter = { isActive: true, balance: { $gte: minAmount } };
  if (Array.isArray(req.body.employees) && req.body.employees.length) {
    filter.employee = { $in: req.body.employees.filter(isId) };
  }

  const khatas = await EmployeeKhata.find(filter).select('employee balance name').lean();
  if (!khatas.length) {
    return res.json({ sent: 0, message: 'Nobody is holding company cash right now.' });
  }

  // One notify per person, because each carries their own figure.
  // Someone holding three floats gets one message per float rather than a
  // single lump sum, because "settle ₹18,000" is not actionable while
  // "settle ₹4,000 on Site A" is.
  await Promise.all(khatas.map((k) => notify({
    recipient: k.employee,
    type: 'general',
    audience: 'employee',
    title: 'Please settle your khata',
    body: `You are holding ₹${k.balance.toLocaleString('en-IN')} of company cash on "${k.name}". `
      + 'Settle it, or record what you have already returned.',
    link: '/employee/khata',
  })));

  const people = new Set(khatas.map((k) => String(k.employee))).size;
  res.json({
    sent: khatas.length,
    people,
    message: `Reminded ${people} ${people === 1 ? 'person' : 'people'} across ${khatas.length} khata(s).`,
  });
});

/**
 * Export the khata to .xlsx — one sheet of balances, one of every entry.
 *
 * Two sheets rather than one because they answer different questions: the
 * balances sheet is what a manager reviews, the ledger sheet is what an auditor
 * reconciles against the cashbook. Every row carries its KHT code and, where
 * one exists, the cash account it moved through, so a line can be traced back
 * to the record months later.
 * @route GET /api/khata/reports/export  (khata.manage)
 * @param {string} [req.query.employee] [req.query.from] [req.query.to] [req.query.status]
 * @returns {binary} An .xlsx stream.
 */
const exportExcel = asyncHandler(async (req, res) => {
  const filter = {};
  if (isId(req.query.employee)) filter.employee = req.query.employee;
  if (req.query.status) filter.status = req.query.status;
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) { to.setHours(23, 59, 59, 999); filter.date.$lte = to; }
  }

  const [entries, khatas] = await Promise.all([
    KhataEntry.find(filter)
      .populate('employee', USER_FIELDS)
      .populate('khata', 'name')
      .populate('cashAccount', 'name')
      .populate('createdBy', USER_FIELDS)
      .populate('reviewedBy', USER_FIELDS)
      .sort({ date: 1, createdAt: 1 })
      .lean(),
    EmployeeKhata.find({ isActive: true }).populate('employee', USER_FIELDS).sort({ balance: -1 }).lean(),
  ]);

  const MONEY = '#,##0.00';
  const name = (u) => (u?.firstName ? `${u.firstName} ${u.lastName || ''}`.trim() : '');
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();

  /** Bold, shaded, frozen header row — matching the cashbook export. */
  const styleHead = (ws) => {
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.alignment = { vertical: 'middle' };
    head.height = 20;
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  // ---- Sheet 1: balances ----
  const bs = wb.addWorksheet('Balances');
  bs.columns = [
    { header: 'Employee', key: 'employee', width: 26 },
    { header: 'Khata', key: 'khata', width: 24 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'You Will Get', key: 'get', width: 14 },
    { header: 'You Will Give', key: 'give', width: 14 },
    { header: 'Khata Limit', key: 'limit', width: 14 },
    { header: 'Last Entry', key: 'last', width: 14 },
  ];
  styleHead(bs);
  for (const k of khatas.filter((x) => x.employee)) {
    const row = bs.addRow({
      employee: name(k.employee),
      khata: k.name,
      email: k.employee.email || '',
      // Split into two columns rather than one signed number, so the sheet reads
      // the same way the screens do and needs no sign convention explained.
      get: k.balance > 0 ? k.balance : null,
      give: k.balance < 0 ? Math.abs(k.balance) : null,
      limit: k.creditLimit || null,
      last: day(k.lastEntryAt),
    });
    ['get', 'give', 'limit'].forEach((c) => { row.getCell(c).numFmt = MONEY; });
  }

  // ---- Sheet 2: the ledger ----
  const ls = wb.addWorksheet('Ledger');
  ls.columns = [
    { header: 'Code', key: 'code', width: 18 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Employee', key: 'employee', width: 24 },
    { header: 'Khata', key: 'khata', width: 22 },
    { header: 'Reason', key: 'type', width: 16 },
    { header: 'Purpose', key: 'purpose', width: 34 },
    { header: 'Given To Employee', key: 'given', width: 18 },
    { header: 'Returned By Employee', key: 'returned', width: 20 },
    { header: 'Balance After', key: 'balanceAfter', width: 14 },
    { header: 'Cash Account', key: 'account', width: 18 },
    { header: 'Moves Company Cash', key: 'movesCash', width: 18 },
    { header: 'Mode', key: 'mode', width: 12 },
    { header: 'Reference', key: 'reference', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Recorded By', key: 'createdBy', width: 20 },
    { header: 'Approved By', key: 'reviewedBy', width: 20 },
  ];
  styleHead(ls);
  for (const e of entries) {
    const row = ls.addRow({
      code: e.code || '',
      date: day(e.date),
      employee: name(e.employee),
      khata: e.khata?.name || '',
      type: e.type,
      purpose: e.purpose || e.category || '',
      given: e.direction === 'to_employee' ? e.amount : null,
      returned: e.direction === 'from_employee' ? e.amount : null,
      balanceAfter: e.status === 'Approved' ? e.balanceAfter : null,
      account: e.cashAccount?.name || '',
      movesCash: e.affectsCompanyCash ? 'Yes' : 'No',
      mode: e.paymentMode || '',
      reference: e.referenceNo || '',
      status: e.status,
      createdBy: name(e.createdBy),
      reviewedBy: name(e.reviewedBy),
    });
    ['given', 'returned', 'balanceAfter'].forEach((c) => { row.getCell(c).numFmt = MONEY; });
  }

  // Column totals, addressed by the column's own letter so inserting a column
  // ahead of them cannot silently move the formula onto the wrong data.
  if (entries.length) {
    const last = entries.length + 1; // header is row 1
    const totals = ls.addRow({ purpose: 'TOTAL' });
    for (const key of ['given', 'returned']) {
      const letter = ls.getColumn(key).letter;
      const cell = ls.getCell(`${letter}${totals.number}`);
      cell.value = { formula: `SUM(${letter}2:${letter}${last})` };
      cell.numFmt = MONEY;
    }
    totals.font = { bold: true };
    totals.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD4D4D8' } } }; });
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const fname = `employee_khata_${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ============================ Receipts ============================

/**
 * Stream an entry's receipt.
 *
 * Authenticates via header OR ?access_token=, because an <img>/<a> cannot set
 * an Authorization header. Visible to the employee it belongs to and to khata
 * managers — the same owner-or-manager rule the cashbook uses.
 * @route GET /api/khata/entries/:id/receipt
 * @returns {binary} 403 if not allowed, 404 if missing.
 */
const getReceipt = asyncHandler(async (req, res) => {
  const entry = await KhataEntry.findById(req.params.id).select('attachment employee');
  if (!entry || !entry.attachment?.storagePath) bad(res, 'Receipt not found', 404);

  const isOwner = String(entry.employee) === String(req.user._id);
  const isManager = hasPermission(req.user, 'khata.manage') || ['CEO', 'MD'].includes(req.user.role);
  if (!isOwner && !isManager) bad(res, 'Not allowed', 403);

  if (entry.attachment.mime) res.setHeader('Content-Type', entry.attachment.mime);
  if (!(await storage.streamTo(entry.attachment.storagePath, res))) bad(res, 'Receipt file missing', 404);
});

module.exports = {
  // employee self-service
  getMyKhata, requestAdvance, declareSettlement,
  // operator lists
  overview, listMyAccounts, listKhatas, getKhata, employeeOptions, listEntries, listPending,
  // money movement
  createEntry, approveEntry, rejectEntry, reverseEntry,
  // settings
  createKhata, createMyKhata, updateKhataSettings, recomputeKhata,
  // reports
  outstandingReport, sendSettleReminders, exportExcel,
  // account operators
  listOperators, setOperators,
  // receipts
  getReceipt,
};
