/**
 * Employee khatabook — the wallet each employee holds, and the expense books
 * they file spending under.
 *
 * THE MODEL, because every endpoint below assumes it. One employee has ONE
 * wallet: the pot the company pays advances into. They open as many khatas as
 * they like — "Site A — materials", "Vehicle & fuel" — and each is an expense
 * book, not a pot of its own. Every expense comes out of the same wallet, so
 * the remaining advance reads identically whichever book you have open, and a
 * person is never flush on one book and stuck on another.
 *
 * TWO GATES ON AN ADVANCE, and they answer different questions.
 *   1. SHOULD THEY HAVE IT? A request parks as 'AwaitingApproval' for a CEO/MD
 *      to sanction. A SuperAdmin can switch this requirement off org-wide
 *      (Setting.khataAdvanceApprovalRequired), after which requests go straight
 *      to the accounts team as they used to.
 *   2. WHERE DOES THE CASH COME FROM? Once sanctioned it parks as 'Pending' for
 *      an operator, who names the cash account it is paid out of. Only then
 *      does any money move.
 * An employee can never release money to themselves at either gate, whatever
 * permissions they hold.
 *
 * Balance arithmetic lives entirely in services/khataLedger.js — this file
 * validates input, decides who may do what, and shapes responses.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const EmployeeKhata = require('../models/EmployeeKhata');
const EmployeeWallet = require('../models/EmployeeWallet');
const KhataEntry = require('../models/KhataEntry');
const { ENTRY_TYPES, PAYMENT_MODES } = require('../models/KhataEntry');
const CashAccount = require('../models/CashAccount');
const Setting = require('../models/Setting');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const storage = require('../services/storage');
const ledger = require('../services/khataLedger');
const { notify, notifyMany } = require('../services/notify');
const { hasPermission } = require('../middleware/authMiddleware');

const USER_FIELDS = 'firstName lastName email role photo';

// ---------------------------------------------------------------------------
// Small shared helpers
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
 * Format a wallet the way the company's own screens must speak about it —
 * never "debit"/"credit".
 *
 * Positive means the employee is holding company cash they have not yet
 * accounted for, which from the company's side reads "you will get". This
 * mapping lives here so the web and the mobile app cannot drift apart on the
 * single most confusable thing in the module.
 * @param {number} balance - Signed balance, company's point of view.
 * @returns {{amount: number, direction: 'get'|'give'|'settled', label: string}}
 */
function describeBalance(balance) {
  const value = ledger.round2(balance || 0);
  if (value > 0) return { amount: value, direction: 'get', label: 'You will get' };
  if (value < 0) return { amount: Math.abs(value), direction: 'give', label: 'You will give' };
  return { amount: 0, direction: 'settled', label: 'Settled up' };
}

/**
 * The same wallet seen from the EMPLOYEE's side.
 *
 * Worded as "in hand" rather than "you owe", because that is what it is: money
 * they are carrying and have yet to account for, not a debt they have run up.
 * @param {number} balance
 * @returns {{amount: number, direction: 'holding'|'owed'|'settled', label: string}}
 */
function describeWalletForEmployee(balance) {
  const value = ledger.round2(balance || 0);
  if (value > 0) return { amount: value, direction: 'holding', label: 'Advance in hand' };
  if (value < 0) return { amount: Math.abs(value), direction: 'owed', label: 'The company owes you' };
  return { amount: 0, direction: 'settled', label: 'Nothing in hand' };
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
  // Which expense book this was filed under. Null for anything that moves the
  // wallet itself — an advance, a settlement, a reimbursement.
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
  // The executive gate, so a queue can show who sanctioned what and when.
  execApprovalRequired: !!e.execApprovalRequired,
  execNote: e.execNote,
  execApprovedAt: e.execApprovedAt || null,
  execApprovedBy: e.execApprovedBy && e.execApprovedBy.firstName
    ? { _id: e.execApprovedBy._id, name: `${e.execApprovedBy.firstName} ${e.execApprovedBy.lastName || ''}`.trim(), role: e.execApprovedBy.role }
    : (e.execApprovedBy?._id || e.execApprovedBy || null),
  createdAt: e.createdAt,
});

/** Allowlist mapper for one expense book. `spent` is a total, not a balance. */
const publicKhata = (k) => ({
  _id: k._id,
  name: k.name,
  isDefault: k.isDefault,
  spent: ledger.round2(k.spent || 0),
  entryCount: k.entryCount || 0,
  lastEntryAt: k.lastEntryAt,
  isActive: k.isActive,
  note: k.note,
});

/** Allowlist mapper for a wallet, from the company's side. */
const publicWallet = (w) => ({
  balance: ledger.round2(w?.balance || 0),
  openingBalance: ledger.round2(w?.openingBalance || 0),
  creditLimit: ledger.round2(w?.creditLimit || 0),
  lastEntryAt: w?.lastEntryAt || null,
  note: w?.note,
  display: describeBalance(w?.balance || 0),
});

/**
 * Is a CEO/MD sanction currently required before an advance reaches accounts?
 *
 * Read fresh rather than cached: it is one indexed lookup on a singleton, and a
 * SuperAdmin turning the gate on expects the very next request to go through
 * it.
 * @returns {Promise<boolean>}
 */
async function advanceApprovalRequired() {
  const s = await Setting.getSettings().catch(() => null);
  // Default ON when the settings document cannot be read: a missing setting
  // must not quietly remove an approval gate.
  return s ? s.khataAdvanceApprovalRequired !== false : true;
}

/**
 * Open a named expense book, shared by the operator and self-service routes.
 *
 * Both paths need identical validation and identical duplicate handling, and
 * the duplicate handling is the fiddly part — see below.
 * @param {object} input
 * @param {string} input.employee - Whose book.
 * @param {string} input.name - What it is for.
 * @param {string} [input.note]
 * @param {object} input.actor - The acting user.
 * @param {object} input.res - For setting the status before throwing.
 * @returns {Promise<object>} The new EmployeeKhata document.
 */
async function openKhata({ employee, name: rawName, note, actor, res }) {
  const name = String(rawName || '').trim();
  if (!name) bad(res, 'Give the khata a name — what will you be spending on?');
  if (name.length > 80) bad(res, 'That name is too long (80 characters max)');

  // Make sure their default exists first, so the FIRST book somebody opens by
  // hand does not accidentally become the fallback for self-service. This also
  // runs the one-time integrity repair (see khataLedger.ensureKhataIntegrity).
  await ledger.getOrCreateDefaultKhata(employee, actor);

  try {
    return await EmployeeKhata.create({
      employee,
      name,
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

/** Who handles the cash: SuperAdmins, Accounts Managers, khata-grant holders. */
async function khataApproverIds() {
  const users = await User.find({
    isActive: true,
    $or: [{ role: { $in: ['SuperAdmin', 'AccountsManager'] } }, { khataAccess: true }],
  }).select('_id');
  return users.map((u) => u._id);
}

/**
 * Who may sanction an advance: the executives, plus SuperAdmins.
 *
 * SuperAdmin is included because somebody has to be able to unblock the queue
 * when no CEO/MD account is set up or available, and a SuperAdmin can already
 * turn the requirement off entirely — so excluding them would buy no safety and
 * only strand requests.
 * @returns {Promise<Array<import('mongoose').Types.ObjectId>>}
 */
async function execApproverIds() {
  const users = await User.find({ isActive: true, role: { $in: ['CEO', 'MD', 'SuperAdmin'] } }).select('_id');
  return users.map((u) => u._id);
}

/**
 * Attach employee-code/designation to a set of rows for the admin lists.
 * One query for the lot rather than one per row.
 * @param {Array<object>} userIds
 * @returns {Promise<Map<string, object>>} Keyed by user id.
 */
async function profilesFor(userIds) {
  const profiles = await EmployeeProfile.find({ user: { $in: userIds } })
    .select('user employeeCode designation department')
    .lean();
  return new Map(profiles.map((p) => [String(p.user), p]));
}

/**
 * Add up an employee's ledger into the figures both portals show.
 *
 * Approved rows only for the money that has actually moved; the waiting ones
 * are counted separately rather than folded in, because a request nobody has
 * acted on has not changed anybody's position and showing it as though it had
 * is how an employee ends up spending money they were never given.
 * @param {Array<object>} entries - The employee's KhataEntry rows.
 * @returns {object} advanced/spent/returned/reimbursed and the waiting counts.
 */
function summariseEntries(entries = []) {
  const s = {
    advanced: 0,      // approved money paid into the wallet
    spent: 0,         // approved expenses filed against books
    returned: 0,      // approved cash handed back / recovered
    awaitingAdvance: 0, // requested, not yet sanctioned
    pendingAdvance: 0,  // sanctioned, not yet paid
    pendingSpend: 0,    // expenses/returns awaiting the company's confirmation
    waitingCount: 0,
  };
  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.status === 'Approved') {
      if (e.direction === 'to_employee') s.advanced += amt;
      else if (e.type === 'expense') s.spent += amt;
      else s.returned += amt;
    } else if (e.status === 'AwaitingApproval' || e.status === 'Pending') {
      s.waitingCount += 1;
      if (e.direction === 'to_employee') {
        if (e.status === 'AwaitingApproval') s.awaitingAdvance += amt;
        else s.pendingAdvance += amt;
      } else {
        s.pendingSpend += amt;
      }
    }
  }
  for (const k of Object.keys(s)) s[k] = k.endsWith('Count') ? s[k] : ledger.round2(s[k]);
  return s;
}

// ============================ Employee self-service ============================

/**
 * The employee's own khatabook: one wallet, their expense books, one statement.
 *
 * The wallet is the headline — "how much of the company's money am I holding?"
 * — and the books below it answer "and what has it gone on?". The same
 * remaining figure applies to every book, which is exactly the point: the money
 * is one pot however many ways the spending is filed.
 * @route GET /api/khata/me
 * @returns {{wallet: object, khatas: Object[], totals: object, entries: Object[]}}
 */
const getMyKhata = asyncHandler(async (req, res) => {
  // Opens their wallet and first book on first visit, so the screen is never
  // empty-handed and the first expense has somewhere to land.
  const [wallet] = await Promise.all([
    ledger.getOrCreateWallet(req.user._id, req.user),
    ledger.getOrCreateDefaultKhata(req.user._id, req.user),
  ]);
  const khatas = await ledger.listKhatasOf(req.user._id, true);

  const entries = await KhataEntry.find({ employee: req.user._id })
    .populate('cashAccount', 'name')
    .populate('khata', 'name')
    .sort({ date: -1, createdAt: -1 })
    .limit(400);

  const sums = summariseEntries(entries);

  res.json({
    wallet: {
      ...publicWallet(wallet),
      // Worded from the employee's side: "advance in hand" / "the company owes you".
      display: describeWalletForEmployee(wallet.balance),
    },
    // Every book, each with what it has cost — and the SAME remaining advance,
    // because there is only one pot behind all of them.
    khatas: khatas.map(publicKhata),
    totals: {
      ...sums,
      remaining: ledger.round2(wallet.balance),
    },
    // Whether a request of theirs will need an executive's sanction, so the
    // form can say so before they send it rather than after.
    approvalRequired: await advanceApprovalRequired(),
    count: entries.length,
    entries: entries.map(publicEntry),
  });
});

/**
 * Ask for a cash advance into your wallet.
 *
 * Never tied to a khata: the money goes into the one pot, and which book it
 * ends up spent against is decided later, purchase by purchase. Always parks —
 * an employee can never release company money to themselves, whatever
 * permissions they hold — but WHERE it parks depends on the org setting: with
 * the executive gate on it waits for a CEO/MD, otherwise it goes straight to
 * whoever handles the cash.
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

  const needsExec = await advanceApprovalRequired();

  const { entry } = await ledger.postEntry({
    employee: req.user._id,
    direction: 'to_employee',
    type: 'advance',
    amount,
    purpose,
    category: req.body.category || 'Advance Request',
    paymentMode: req.body.paymentMode || 'Cash',
    date: parseDate(req.body.date) || new Date(),
    // The employee names no account and approves nothing: an executive decides
    // whether they should have it, an operator decides which book it comes out
    // of, and only then does any cash move.
    autoApprove: false,
    status: needsExec ? 'AwaitingApproval' : 'Pending',
    execApprovalRequired: needsExec,
    raisedByEmployee: true,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  const who = `${req.user.firstName} ${req.user.lastName || ''}`.trim();
  if (needsExec) {
    await notifyMany(await execApproverIds(), {
      type: 'general',
      audience: 'admin',
      title: 'Advance request needs your approval',
      body: `${who} requested ₹${amount.toLocaleString('en-IN')} — ${purpose}`,
      link: '/admin/khata',
    });
  } else {
    await notifyMany(await khataApproverIds(), {
      type: 'general',
      audience: 'admin',
      title: 'Cash advance requested',
      body: `${who} requested ₹${amount.toLocaleString('en-IN')} — ${purpose}`,
      link: '/admin/khata',
    });
  }

  res.status(201).json({
    entry: publicEntry(entry),
    message: needsExec
      ? 'Request sent to the CEO/MD for approval.'
      : 'Request sent for approval',
  });
});

/**
 * Record something you spent the advance on, filed against one of your books.
 *
 * This is the everyday action of the whole module: the employee holds one
 * advance and logs purchases against whichever book they belong to. The spend
 * comes out of the wallet, so the remaining figure drops whichever book it was
 * filed under.
 *
 * It parks for the company to confirm rather than posting on the spot, for the
 * same reason a declared settlement does: an entry that moves what the company
 * is owed should be seen by the company. The employee's screen shows the
 * waiting amount alongside the confirmed one, so nothing is hidden while it
 * waits.
 * @route POST /api/khata/me/expense
 * @param {string} req.body.khata - Which book it belongs to.
 * @param {number} req.body.amount
 * @param {string} req.body.purpose - What was bought.
 * @param {file} [req.file] - Optional receipt (multer field 'receipt').
 * @returns {{entry: object, message: string}} 201
 */
const recordMyExpense = asyncHandler(async (req, res) => {
  const amount = toNum(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) bad(res, 'Enter how much you spent');
  const purpose = String(req.body.purpose || '').trim();
  if (!purpose) bad(res, 'Say what you spent it on');

  const { entry, khata } = await ledger.postEntry({
    employee: req.user._id,
    // Which book it belongs to. The ledger refuses one that is not theirs or
    // has been closed, and falls back to their default when none is named.
    khata: isId(req.body.khata) ? req.body.khata : undefined,
    direction: 'from_employee',
    type: 'expense',
    amount,
    purpose,
    category: req.body.category || 'Expense',
    paymentMode: req.body.paymentMode || 'Cash',
    referenceNo: req.body.referenceNo,
    date: parseDate(req.body.date) || new Date(),
    // No company cash moves here — it left the tin when the advance was paid.
    // Recording the spend accounts for money already in the employee's hand.
    affectsCompanyCash: false,
    autoApprove: false,
    raisedByEmployee: true,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  await attachReceipt(entry, req.file);

  await notifyMany(await khataApproverIds(), {
    type: 'general',
    audience: 'admin',
    title: 'Expense recorded against an advance',
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim()
      + ` logged ₹${amount.toLocaleString('en-IN')} on "${khata.name}" — ${purpose}`,
    link: '/admin/khata',
  });

  res.status(201).json({
    entry: publicEntry(entry),
    khata: publicKhata(khata),
    message: 'Recorded — it will come off your advance once the company confirms it.',
  });
});

/**
 * Declare unspent cash handed back to the company.
 *
 * Wallet-level, like the advance it reverses: you are returning money from the
 * pot, not from any one book. Parks as Pending — the company confirms it
 * actually received the money before the employee's advance drops.
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
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim() + ` says they returned ₹${amount.toLocaleString('en-IN')} — confirm to update their wallet`,
    link: '/admin/khata',
  });

  res.status(201).json({ entry: publicEntry(entry), message: 'Sent for confirmation' });
});

// ============================ Operator: overview & lists ============================

/**
 * Headline figures for the khata dashboard.
 * @route GET /api/khata/overview  (khata.manage)
 * @returns {{totalReceivable: number, totalPayable: number, employeesOutstanding: number, pendingCount: number, awaitingApprovalCount: number, accounts: Object[]}}
 */
const overview = asyncHandler(async (req, res) => {
  // Usually the first khata screen anyone opens, so it is where a database that
  // predates multi-khata gets repaired. Memoized — one check per process.
  await ledger.ensureKhataIntegrity();
  const wallets = await EmployeeWallet.find({}).select('balance employee').lean();

  // The two things a manager actually asks: what is out with staff, and what do
  // we owe them. Never netted — a person holding ₹5,000 while somebody else is
  // owed ₹2,000 is two facts, and one ₹3,000 figure hides the payable entirely.
  let totalReceivable = 0;
  let totalPayable = 0;
  let employeesOutstanding = 0;
  for (const w of wallets) {
    if (w.balance > 0) { totalReceivable += w.balance; employeesOutstanding += 1; }
    else if (w.balance < 0) { totalPayable += Math.abs(w.balance); employeesOutstanding += 1; }
  }

  const [pendingCount, awaitingApprovalCount, activeKhatas] = await Promise.all([
    KhataEntry.countDocuments({ status: 'Pending' }),
    KhataEntry.countDocuments({ status: 'AwaitingApproval' }),
    EmployeeKhata.countDocuments({ isActive: true }),
  ]);

  res.json({
    totalReceivable: ledger.round2(totalReceivable),
    totalPayable: ledger.round2(totalPayable),
    net: ledger.round2(totalReceivable - totalPayable),
    employeesOutstanding,
    activeKhatas,
    peopleWithKhatas: wallets.length,
    pendingCount,
    awaitingApprovalCount,
    approvalRequired: await advanceApprovalRequired(),
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
 * Every employee's wallet, for the "who is holding what" list.
 *
 * One row per PERSON, which is now simply what the data is: one wallet each.
 * Each row carries their expense books alongside, so the list can expand into
 * "and what have they spent it on?".
 * @route GET /api/khata/employees  (khata.manage)
 * @param {string} [req.query.q] - Name/email/book search.
 * @param {string} [req.query.filter] - 'outstanding' | 'payable' | 'settled' | 'all'.
 * @returns {{count: number, rows: Object[]}}
 */
const listKhatas = asyncHandler(async (req, res) => {
  await ledger.ensureKhataIntegrity();

  const wallets = await EmployeeWallet.find({})
    .populate('employee', USER_FIELDS)
    .lean();

  // Drop wallets whose user was deleted, so the list never shows an orphan row.
  const live = wallets.filter((w) => w.employee);
  const ids = live.map((w) => w.employee._id);

  const [profiles, khatas] = await Promise.all([
    profilesFor(ids),
    EmployeeKhata.find({ employee: { $in: ids } }).sort({ isDefault: -1, name: 1 }).lean(),
  ]);

  const booksByEmployee = new Map();
  for (const k of khatas) {
    const id = String(k.employee);
    if (!booksByEmployee.has(id)) booksByEmployee.set(id, []);
    booksByEmployee.get(id).push(publicKhata(k));
  }

  let rows = live.map((w) => {
    const id = String(w.employee._id);
    const profile = profiles.get(id);
    const books = booksByEmployee.get(id) || [];
    return {
      employee: {
        _id: w.employee._id,
        name: `${w.employee.firstName} ${w.employee.lastName || ''}`.trim(),
        email: w.employee.email,
        photo: w.employee.photo || null,
        employeeCode: profile?.employeeCode,
        designation: profile?.designation,
        department: profile?.department,
      },
      // The wallet is the position; `total` keeps the old key so nothing that
      // sorted or filtered on it has to change.
      total: ledger.round2(w.balance || 0),
      wallet: publicWallet(w),
      display: describeBalance(w.balance),
      creditLimit: ledger.round2(w.creditLimit || 0),
      lastEntryAt: w.lastEntryAt || null,
      khatas: books,
      totalSpent: ledger.round2(books.reduce((a, b) => a + (b.spent || 0), 0)),
    };
  });

  const filter = req.query.filter || 'all';
  if (filter === 'outstanding') rows = rows.filter((r) => r.total > 0);
  else if (filter === 'payable') rows = rows.filter((r) => r.total < 0);
  else if (filter === 'settled') rows = rows.filter((r) => r.total === 0);

  const q = String(req.query.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.employee.name.toLowerCase().includes(q)
      || String(r.employee.email || '').toLowerCase().includes(q)
      || String(r.employee.employeeCode || '').toLowerCase().includes(q)
      // Searching a book name is how you find "who is spending on Site A".
      || r.khatas.some((k) => k.name.toLowerCase().includes(q)));
  }

  rows.sort((a, b) => b.total - a.total);

  res.json({ count: rows.length, rows, totals: ledger.splitTotals(live) });
});

/**
 * One employee's wallet, their expense books, and their full statement.
 * @route GET /api/khata/employees/:employeeId  (khata.manage)
 * @returns {{wallet: object, khatas: Object[], entries: Object[]}}
 */
const getKhata = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  if (!isId(employeeId)) bad(res, 'Invalid employee', 400);

  const employee = await User.findById(employeeId).select(USER_FIELDS);
  if (!employee) bad(res, 'Employee not found', 404);

  // Opens the wallet and their first book on first view, so a person with
  // nothing yet still has somewhere for the first advance to land.
  const [wallet] = await Promise.all([
    ledger.getOrCreateWallet(employeeId, req.user),
    ledger.getOrCreateDefaultKhata(employeeId, req.user),
  ]);
  const khatas = await ledger.listKhatasOf(employeeId, true);

  const profile = await EmployeeProfile.findOne({ user: employeeId })
    .select('employeeCode designation department').lean();

  const filter = { employee: employeeId };
  // Narrow to a single book when one is named; otherwise show everything,
  // which is the view that answers "what is going on with this person?".
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
    .populate('execApprovedBy', 'firstName lastName role')
    .sort({ date: -1, createdAt: -1 })
    .limit(1000);

  res.json({
    wallet: publicWallet(wallet),
    khatas: khatas.map(publicKhata),
    employee: {
      _id: employee._id,
      name: `${employee.firstName} ${employee.lastName || ''}`.trim(),
      email: employee.email,
      photo: employee.photo || null,
      employeeCode: profile?.employeeCode,
      designation: profile?.designation,
      department: profile?.department,
    },
    total: ledger.round2(wallet.balance || 0),
    balance: describeBalance(wallet.balance),
    // Summed over the WHOLE ledger, not the filtered slice, so narrowing to one
    // book never makes the headline figures disagree with the wallet.
    totals: summariseEntries(await KhataEntry.find({ employee: employeeId }).select('status direction type amount').lean()),
    count: entries.length,
    entries: entries.map(publicEntry),
  });
});

/**
 * Open a new expense book for an employee.
 *
 * Any khata operator can open one, because deciding that spending needs its own
 * heading is part of running the cash, not an admin act. Opening a book moves
 * no money at all — it is a folder.
 * @route POST /api/khata/khatas  (khata.manage)
 * @param {string} req.body.employee - Whose book.
 * @param {string} req.body.name - What it is for.
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
    note: req.body.note,
    actor: req.user,
    res,
  });

  await notify({
    recipient: employee,
    type: 'general',
    audience: 'employee',
    title: 'New khata opened',
    body: `A khata called "${khata.name}" was opened for you. You can record expenses against it from My Khata.`,
    link: '/employee/khata',
  });

  res.status(201).json({ khata: publicKhata(khata), message: `"${khata.name}" opened.` });
});

/**
 * Open an expense book on your own account.
 *
 * The employee taking on a new job — a second site, a vehicle — knows they need
 * a separate heading before finance does, and making them wait on an operator
 * just to name one is friction with no safety value: a book holds no money.
 * @route POST /api/khata/me/khatas
 * @param {string} req.body.name - What the book is for.
 * @param {string} [req.body.note]
 * @returns {{khata: object, message: string}} 201
 */
const createMyKhata = asyncHandler(async (req, res) => {
  // A soft cap. Opening a book is harmless, but a runaway loop or a bored
  // tester should not be able to fill the list with hundreds.
  const existing = await EmployeeKhata.countDocuments({ employee: req.user._id });
  if (existing >= 25) {
    bad(res, 'You already have 25 khatas. Close one you have finished with before opening another.');
  }

  const khata = await openKhata({
    employee: req.user._id,
    name: req.body.name,
    note: req.body.note,
    actor: req.user,
    res,
  });

  res.status(201).json({ khata: publicKhata(khata), message: `"${khata.name}" opened.` });
});

/**
 * Employees available to give an advance to — the give-advance picker.
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

  const ids = users.map((u) => u._id);
  const [profiles, wallets] = await Promise.all([
    profilesFor(ids),
    EmployeeWallet.find({ employee: { $in: ids } }).select('employee balance creditLimit').lean(),
  ]);
  const walletBy = new Map(wallets.map((w) => [String(w.employee), w]));

  res.json({
    count: users.length,
    employees: users.map((u) => {
      const profile = profiles.get(String(u._id));
      const wallet = walletBy.get(String(u._id));
      return {
        _id: u._id,
        name: `${u.firstName} ${u.lastName || ''}`.trim(),
        email: u.email,
        photo: u.photo || null,
        employeeCode: profile?.employeeCode,
        designation: profile?.designation,
        department: profile?.department,
        // So the picker can warn "already holds ₹4,000" before a second advance.
        balance: ledger.round2(wallet?.balance || 0),
        creditLimit: ledger.round2(wallet?.creditLimit || 0),
      };
    }),
  });
});

// ============================ Operator: posting money ============================

/**
 * Post an entry on the company's behalf — give an advance, take cash back, or
 * record a spend against one of the employee's books.
 *
 * Whether the money moves now or parks for approval is decided by the
 * operator's own limit on the chosen account (CashAccount.operators), never by
 * anything the client sends. An operator can therefore always ask, and never
 * over-release.
 * @route POST /api/khata/entries  (khata.manage)
 * @param {string} req.body.employee - Whose wallet.
 * @param {'to_employee'|'from_employee'} req.body.direction
 * @param {number} req.body.amount
 * @param {string} [req.body.khata] - Required when `type` is 'expense'.
 * @param {string} req.body.cashAccount - Which company book the cash moves through.
 * @param {boolean} [req.body.affectsCompanyCash=true] - False when no company cash moves.
 * @param {file} [req.file] - Optional receipt (multer field 'receipt').
 * @returns {{entry: object, wallet: object, posted: boolean, message: string}} 201
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
  // Spending has to say what it was for. Everything else is wallet-level and a
  // khata id sent alongside it would be silently dropped, so refuse it loudly
  // rather than record something the operator did not mean.
  if (ledger.needsKhata(type)) {
    if (!isId(req.body.khata)) bad(res, 'Choose which khata this expense belongs to.');
    // Spending only ever reduces what somebody is holding. A row typed as an
    // expense but pointed the other way would ADD to their advance while
    // charging the cost to a book — wrong in both directions at once, and
    // silently so, since nothing else about it would look unusual.
    if (direction !== 'from_employee') {
      bad(res, 'An expense is money going out of the advance. Record money out to an employee as an advance instead.');
    }
  }

  // An employee's own spend, an expense against an advance, or a payroll
  // recovery moves no company cash and so needs no account and no operator
  // rights — it only shifts what is owed.
  const affectsCompanyCash = ledger.needsKhata(type)
    ? false
    : String(req.body.affectsCompanyCash) !== 'false';

  let autoApprove = true;
  let accountId;
  if (affectsCompanyCash) {
    const { account, rights } = await requireOperableAccount(req.user, req.body.cashAccount, res);
    accountId = account._id;
    // The threshold rule: within their limit it posts now; above it, it parks.
    autoApprove = ledger.willAutoApprove(rights, amount);
  }

  const paymentMode = PAYMENT_MODES.includes(req.body.paymentMode) ? req.body.paymentMode : 'Cash';

  const { entry, wallet, khata, duplicate } = await ledger.postEntry({
    employee,
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
      wallet: publicWallet(wallet),
      khata: khata ? publicKhata(khata) : null,
      posted: entry.status === 'Approved',
      message: 'Already recorded — this entry was submitted before.',
    });
  }

  await attachReceipt(entry, req.file);

  if (autoApprove) {
    // Tell the employee their own wallet moved, in their own words.
    const inHand = Math.abs(wallet.balance).toLocaleString('en-IN');
    await notify({
      recipient: employee,
      type: 'general',
      audience: 'employee',
      title: direction === 'to_employee' ? 'Cash advance received' : 'Khata entry recorded',
      body: direction === 'to_employee'
        ? `₹${amount.toLocaleString('en-IN')} was added to your advance. You now have ₹${inHand} in hand.`
        : `₹${amount.toLocaleString('en-IN')} was recorded${khata ? ` against "${khata.name}"` : ''}. `
          + `You now have ₹${inHand} in hand.`,
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
    wallet: publicWallet(wallet),
    khata: khata ? publicKhata(khata) : null,
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
    .populate('execApprovedBy', 'firstName lastName role')
    .sort({ date: -1, createdAt: -1 })
    .limit(limit);

  res.json({ count: entries.length, entries: entries.map(publicEntry) });
});

/**
 * Everything waiting on the ACCOUNTS team — sanctioned advances to pay out,
 * expenses and returns to confirm.
 *
 * Deliberately excludes anything still with an executive: an operator cannot
 * act on it, and a queue full of rows you must not touch is worse than no queue.
 * @route GET /api/khata/pending  (khata.manage)
 * @returns {{count: number, entries: Object[]}}
 */
const listPending = asyncHandler(async (req, res) => {
  const entries = await KhataEntry.find({ status: 'Pending' })
    .populate('employee', USER_FIELDS)
    .populate('khata', 'name')
    .populate('cashAccount', 'name')
    .populate('execApprovedBy', 'firstName lastName role')
    .sort({ createdAt: 1 });
  res.json({ count: entries.length, entries: entries.map(publicEntry) });
});

// ============================ Executive sanction ============================

/**
 * Advance requests waiting on a CEO/MD decision.
 *
 * Its own endpoint rather than a filter on /pending because it has its own
 * audience: an executive holds no khata capability and has no business in the
 * operators' queue, and vice versa.
 * @route GET /api/khata/advance-approvals  (SuperAdmin/CEO/MD)
 * @returns {{count: number, entries: Object[], approvalRequired: boolean}}
 */
const listAdvanceApprovals = asyncHandler(async (req, res) => {
  const entries = await KhataEntry.find({ status: 'AwaitingApproval' })
    .populate('employee', USER_FIELDS)
    .populate('khata', 'name')
    .sort({ createdAt: 1 });

  // The requester's current position, so the decision is not made blind — "they
  // already hold ₹8,000 and want ₹5,000 more" is the whole question.
  const wallets = await EmployeeWallet.find({ employee: { $in: entries.map((e) => e.employee?._id || e.employee) } })
    .select('employee balance creditLimit').lean();
  const walletBy = new Map(wallets.map((w) => [String(w.employee), w]));

  res.json({
    count: entries.length,
    approvalRequired: await advanceApprovalRequired(),
    entries: entries.map((e) => {
      const w = walletBy.get(String(e.employee?._id || e.employee));
      return {
        ...publicEntry(e),
        employeeBalance: ledger.round2(w?.balance || 0),
        employeeCreditLimit: ledger.round2(w?.creditLimit || 0),
      };
    }),
  });
});

/**
 * Sanction or decline an advance request.
 *
 * Sanctioning moves NO money — it releases the request into the accounts
 * team's queue, where somebody decides which account it is paid from. That
 * separation is the point: the person who says "yes, they should have it" is
 * not the person holding the cash box.
 * @route PATCH /api/khata/entries/:id/exec-decision  (SuperAdmin/CEO/MD)
 * @param {boolean} req.body.approve
 * @param {string} [req.body.note] - Shown to the employee either way.
 * @returns {{entry: object, message: string}}
 */
const decideAdvanceApproval = asyncHandler(async (req, res) => {
  const entry = await KhataEntry.findById(req.params.id).populate('employee', USER_FIELDS);
  if (!entry) bad(res, 'Request not found', 404);
  if (entry.direction !== 'to_employee') bad(res, 'Only an advance request goes through this approval.');

  const approve = req.body.approve === true || req.body.approve === 'true';
  const note = req.body.note ? String(req.body.note).trim() : '';
  if (!approve && !note) bad(res, 'Give a reason for declining — the employee sees it.');

  const saved = await ledger.decideExecApproval(entry, req.user, approve, note);

  const amount = saved.amount.toLocaleString('en-IN');
  await notify({
    recipient: saved.employee?._id || saved.employee,
    type: 'general',
    audience: 'employee',
    title: approve ? 'Advance approved' : 'Advance request declined',
    body: approve
      ? `Your ₹${amount} advance was approved. The accounts team will pay it out.`
      : `Your ₹${amount} advance request was declined: ${note}`,
    link: '/employee/khata',
  });

  if (approve) {
    await notifyMany(await khataApproverIds(), {
      type: 'general',
      audience: 'admin',
      title: 'Approved advance ready to pay',
      body: `₹${amount} for ${saved.employee?.firstName || 'an employee'} was approved by ${req.user.role}. Choose an account and pay it out.`,
      link: '/admin/khata',
    });
  }

  res.json({
    entry: publicEntry(saved),
    message: approve
      ? 'Approved — it is now with the accounts team to pay out.'
      : 'Declined. Nothing has moved.',
  });
});

// ============================ Operator: deciding parked entries ============================

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
 * @returns {{entry: object, wallet: object, message: string}}
 */
const approveEntry = asyncHandler(async (req, res) => {
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'Entry not found', 404);
  if (entry.status === 'AwaitingApproval') {
    bad(res, 'This advance still needs a CEO/MD approval before it can be paid.');
  }
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

  const { entry: saved, wallet, khata } = await ledger.approveEntry(entry, req.user, {
    cashAccount: accountId,
    note: req.body.note,
  });

  await notify({
    recipient: saved.employee,
    type: 'general',
    audience: 'employee',
    title: saved.type === 'expense' ? 'Expense confirmed' : 'Khata entry approved',
    body: saved.type === 'expense'
      ? `₹${saved.amount.toLocaleString('en-IN')} on "${khata?.name || 'your khata'}" was confirmed. `
        + `You have ₹${Math.abs(wallet.balance).toLocaleString('en-IN')} in hand.`
      : `₹${saved.amount.toLocaleString('en-IN')} has been posted to your khata (${saved.code || 'entry'}).`,
    link: '/employee/khata',
  });

  res.json({
    entry: publicEntry(saved),
    wallet: publicWallet(wallet),
    khata: khata ? publicKhata(khata) : null,
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
  // An advance still with an executive is theirs to decline, not the operators'
  // — otherwise the accounts team could quietly overrule a pending sanction.
  if (entry.status === 'AwaitingApproval') {
    bad(res, 'This request is with the CEO/MD. They decide it.');
  }

  const saved = await ledger.rejectEntry(entry, req.user, req.body.note);

  await notify({
    recipient: saved.employee,
    type: 'general',
    audience: 'employee',
    title: 'Khata request declined',
    body: req.body.note
      ? `Your ₹${saved.amount.toLocaleString('en-IN')} entry was declined: ${req.body.note}`
      : `Your ₹${saved.amount.toLocaleString('en-IN')} entry was declined.`,
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
 * @returns {{original: object, reversal: object, wallet: object, message: string}}
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

  const { original, reversal, wallet, khata } = await ledger.reverseEntry(entry, req.user, req.body.reason);

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
    wallet: publicWallet(wallet),
    khata: khata ? publicKhata(khata) : null,
    message: 'Reversed. Both entries stay on the record.',
  });
});

// ============================ Wallet & khata settings ============================

/**
 * Set an employee's advance limit, opening balance or note.
 *
 * The limit lives on the WALLET rather than on each book, because the pot is
 * the person's: a per-book limit could be walked around simply by opening
 * another book.
 *
 * The opening balance is SuperAdmin-only: it is the one number that changes the
 * balance with no ledger row behind it, so it must not be reachable by an
 * ordinary operator.
 * @route PUT /api/khata/wallets/:employeeId  (khata.manage)
 * @param {number} [req.body.creditLimit]
 * @param {number} [req.body.openingBalance] - SuperAdmin only.
 * @param {string} [req.body.note]
 * @returns {{wallet: object, message: string}}
 */
const updateWalletSettings = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  if (!isId(employeeId)) bad(res, 'Invalid employee');

  const wallet = await ledger.getOrCreateWallet(employeeId, req.user);

  if (req.body.creditLimit !== undefined) {
    const limit = toNum(req.body.creditLimit);
    if (!Number.isFinite(limit) || limit < 0) bad(res, 'The advance limit must be zero or more');
    wallet.creditLimit = ledger.round2(limit);
  }
  if (req.body.note !== undefined) wallet.note = String(req.body.note).slice(0, 300);

  let recompute = false;
  if (req.body.openingBalance !== undefined) {
    if (req.user.role !== 'SuperAdmin') {
      bad(res, 'Only a Super Admin can set an opening balance — it moves the balance with no ledger entry behind it.', 403);
    }
    const opening = toNum(req.body.openingBalance);
    if (!Number.isFinite(opening)) bad(res, 'Enter a valid opening balance');
    wallet.openingBalance = ledger.round2(opening);
    recompute = true;
  }

  await wallet.save();
  if (recompute) await ledger.recomputeWalletBalance(employeeId);

  const fresh = await EmployeeWallet.findOne({ employee: employeeId });
  res.json({ wallet: publicWallet(fresh), display: describeBalance(fresh.balance), message: 'Saved' });
});

/**
 * Rename, re-note, re-default or close one expense book.
 *
 * A book carrying spend CAN be closed, unlike the old balance-carrying khata:
 * `spent` is history, not an outstanding amount, and the money itself lives on
 * the wallet where closing a folder cannot hide it.
 * @route PUT /api/khata/khatas/:khataId  (khata.manage)
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
  if (req.body.note !== undefined) khata.note = String(req.body.note).slice(0, 300);

  if (req.body.isActive !== undefined) {
    const nextActive = req.body.isActive === true || req.body.isActive === 'true';
    // The fallback book has to stay open, or self-service has nowhere to file
    // an expense from somebody with no other book.
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

  await khata.save();
  res.json({ khata: publicKhata(khata), message: 'Saved' });
});

/**
 * Rebuild an employee's wallet and books from their ledger.
 *
 * Balances are already recomputed after every change, so this is a repair tool
 * rather than part of any normal flow — for use after a direct database edit or
 * a restored backup.
 * @route POST /api/khata/wallets/:employeeId/recompute  (SuperAdmin)
 * @returns {{balance: number, message: string}}
 */
const recomputeWallet = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  if (!isId(employeeId)) bad(res, 'Invalid employee');

  // Rebuild every book first, then the pot: the pot is what people read off the
  // screen, so it should be the figure computed against a settled set of books.
  const khatas = await EmployeeKhata.find({ employee: employeeId }).select('_id');
  for (const k of khatas) await ledger.recomputeKhataSpent(k._id);
  const balance = await ledger.recomputeWalletBalance(employeeId);

  res.json({
    balance,
    display: describeBalance(balance),
    message: `Rebuilt from the ledger — ${khatas.length} khata(s) and the wallet.`,
  });
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
 * Who is holding company cash, oldest-first, with an ageing band each.
 *
 * The question this answers is not "how much is out?" but "who has been sitting
 * on it, and for how long?" — which is what actually drives a collection chase.
 * Ageing is measured from the last movement on the wallet: somebody settling
 * weekly is not stale even if their advance is large.
 * @route GET /api/khata/reports/outstanding  (khata.manage)
 * @param {string} [req.query.minAmount] - Hide balances below this.
 * @returns {{count: number, total: number, buckets: object, rows: Object[]}}
 */
const outstandingReport = asyncHandler(async (req, res) => {
  const minAmount = Number(req.query.minAmount) || 0;

  const wallets = await EmployeeWallet.find({ balance: { $gt: minAmount } })
    .populate('employee', USER_FIELDS)
    .sort({ lastEntryAt: 1 })
    .lean();

  const live = wallets.filter((w) => w.employee);
  const [profiles, khatas] = await Promise.all([
    profilesFor(live.map((w) => w.employee._id)),
    EmployeeKhata.find({ employee: { $in: live.map((w) => w.employee._id) }, isActive: true })
      .select('employee name spent').lean(),
  ]);
  const booksBy = new Map();
  for (const k of khatas) {
    const id = String(k.employee);
    if (!booksBy.has(id)) booksBy.set(id, []);
    booksBy.get(id).push({ _id: k._id, name: k.name, spent: ledger.round2(k.spent || 0) });
  }

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const buckets = { current: 0, days30: 0, days60: 0, days90plus: 0 };

  const out = live.map((w) => {
    // No movement at all means the opening balance has never been touched,
    // which is the stalest case there is — the oldest band, not the newest.
    const days = w.lastEntryAt ? Math.floor((now - new Date(w.lastEntryAt).getTime()) / DAY) : 9999;
    const band = days <= 30 ? 'current' : days <= 60 ? 'days30' : days <= 90 ? 'days60' : 'days90plus';
    buckets[band] = ledger.round2(buckets[band] + w.balance);

    const profile = profiles.get(String(w.employee._id));
    return {
      employee: {
        _id: w.employee._id,
        name: `${w.employee.firstName} ${w.employee.lastName || ''}`.trim(),
        email: w.employee.email,
        employeeCode: profile?.employeeCode,
        designation: profile?.designation,
        department: profile?.department,
      },
      balance: ledger.round2(w.balance),
      creditLimit: ledger.round2(w.creditLimit || 0),
      // What they have been spending it on, so the chase can start with a
      // question rather than an accusation.
      khatas: booksBy.get(String(w.employee._id)) || [],
      lastEntryAt: w.lastEntryAt,
      daysSinceLastEntry: w.lastEntryAt ? days : null,
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
 * One notification per person — the wallet is per person, so there is exactly
 * one figure to quote. Deliberately a manual action rather than a cron: a
 * reminder is a relationship event, and finance should choose when to send it
 * rather than have it fire nightly.
 * @route POST /api/khata/reports/remind  (khata.manage)
 * @param {string[]} [req.body.employees] - Specific people; omit for everyone outstanding.
 * @param {number} [req.body.minAmount=1] - Skip trivial balances.
 * @returns {{sent: number, message: string}}
 */
const sendSettleReminders = asyncHandler(async (req, res) => {
  const minAmount = Number(req.body.minAmount) > 0 ? Number(req.body.minAmount) : 1;
  const filter = { balance: { $gte: minAmount } };
  if (Array.isArray(req.body.employees) && req.body.employees.length) {
    filter.employee = { $in: req.body.employees.filter(isId) };
  }

  const wallets = await EmployeeWallet.find(filter).select('employee balance').lean();
  if (!wallets.length) {
    return res.json({ sent: 0, message: 'Nobody is holding company cash right now.' });
  }

  await Promise.all(wallets.map((w) => notify({
    recipient: w.employee,
    type: 'general',
    audience: 'employee',
    title: 'Please account for your advance',
    body: `You are holding ₹${w.balance.toLocaleString('en-IN')} of company cash. `
      + 'Record what you have spent it on, or return what is left.',
    link: '/employee/khata',
  })));

  res.json({
    sent: wallets.length,
    people: wallets.length,
    message: `Reminded ${wallets.length} ${wallets.length === 1 ? 'person' : 'people'}.`,
  });
});

/**
 * Export to .xlsx — wallets, expense books, and every ledger row.
 *
 * Three sheets because they answer three questions: the wallets sheet is what a
 * manager reviews ("who is holding what"), the khatas sheet is what a budget
 * holder reads ("what has each job cost"), and the ledger sheet is what an
 * auditor reconciles against the cashbook. Every ledger row carries its KHT
 * code and, where one exists, the cash account it moved through, so a line can
 * be traced back to the record months later.
 * @route GET /api/khata/reports/export  (khata.manage + khataExportAccess)
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

  const [entries, wallets, khatas] = await Promise.all([
    KhataEntry.find(filter)
      .populate('employee', USER_FIELDS)
      .populate('khata', 'name')
      .populate('cashAccount', 'name')
      .populate('createdBy', USER_FIELDS)
      .populate('reviewedBy', USER_FIELDS)
      .populate('execApprovedBy', USER_FIELDS)
      .sort({ date: 1, createdAt: 1 })
      .lean(),
    EmployeeWallet.find({}).populate('employee', USER_FIELDS).sort({ balance: -1 }).lean(),
    EmployeeKhata.find({}).populate('employee', USER_FIELDS).sort({ spent: -1 }).lean(),
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

  // ---- Sheet 1: wallets ----
  const bs = wb.addWorksheet('Wallets');
  bs.columns = [
    { header: 'Employee', key: 'employee', width: 26 },
    { header: 'Email', key: 'email', width: 26 },
    { header: 'You Will Get', key: 'get', width: 14 },
    { header: 'You Will Give', key: 'give', width: 14 },
    { header: 'Advance Limit', key: 'limit', width: 14 },
    { header: 'Last Entry', key: 'last', width: 14 },
  ];
  styleHead(bs);
  for (const w of wallets.filter((x) => x.employee)) {
    const row = bs.addRow({
      employee: name(w.employee),
      email: w.employee.email || '',
      // Split into two columns rather than one signed number, so the sheet reads
      // the same way the screens do and needs no sign convention explained.
      get: w.balance > 0 ? w.balance : null,
      give: w.balance < 0 ? Math.abs(w.balance) : null,
      limit: w.creditLimit || null,
      last: day(w.lastEntryAt),
    });
    ['get', 'give', 'limit'].forEach((c) => { row.getCell(c).numFmt = MONEY; });
  }

  // ---- Sheet 2: expense books ----
  const ks = wb.addWorksheet('Khatas');
  ks.columns = [
    { header: 'Employee', key: 'employee', width: 26 },
    { header: 'Khata', key: 'khata', width: 28 },
    { header: 'Spent', key: 'spent', width: 14 },
    { header: 'Entries', key: 'entries', width: 10 },
    { header: 'Last Entry', key: 'last', width: 14 },
    { header: 'Status', key: 'status', width: 10 },
  ];
  styleHead(ks);
  for (const k of khatas.filter((x) => x.employee)) {
    const row = ks.addRow({
      employee: name(k.employee),
      khata: k.name,
      spent: k.spent || 0,
      entries: k.entryCount || 0,
      last: day(k.lastEntryAt),
      status: k.isActive ? 'Open' : 'Closed',
    });
    row.getCell('spent').numFmt = MONEY;
  }

  // ---- Sheet 3: the ledger ----
  const ls = wb.addWorksheet('Ledger');
  ls.columns = [
    { header: 'Code', key: 'code', width: 18 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Employee', key: 'employee', width: 24 },
    { header: 'Khata', key: 'khata', width: 22 },
    { header: 'Reason', key: 'type', width: 16 },
    { header: 'Purpose', key: 'purpose', width: 34 },
    { header: 'Given To Employee', key: 'given', width: 18 },
    { header: 'Spent / Returned', key: 'returned', width: 18 },
    { header: 'In Hand After', key: 'balanceAfter', width: 14 },
    { header: 'Cash Account', key: 'account', width: 18 },
    { header: 'Moves Company Cash', key: 'movesCash', width: 18 },
    { header: 'Mode', key: 'mode', width: 12 },
    { header: 'Reference', key: 'reference', width: 16 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Recorded By', key: 'createdBy', width: 20 },
    { header: 'Approved By (CEO/MD)', key: 'execBy', width: 20 },
    { header: 'Posted By', key: 'reviewedBy', width: 20 },
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
      execBy: name(e.execApprovedBy),
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
  getMyKhata, requestAdvance, recordMyExpense, declareSettlement,
  // operator lists
  overview, listMyAccounts, listKhatas, getKhata, employeeOptions, listEntries, listPending,
  // executive sanction
  listAdvanceApprovals, decideAdvanceApproval,
  // money movement
  createEntry, approveEntry, rejectEntry, reverseEntry,
  // settings
  createKhata, createMyKhata, updateKhataSettings, updateWalletSettings, recomputeWallet,
  // reports
  outstandingReport, sendSettleReminders, exportExcel,
  // account operators
  listOperators, setOperators,
  // receipts
  getReceipt,
};
