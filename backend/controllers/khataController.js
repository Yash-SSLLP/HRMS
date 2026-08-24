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
// The employee ledger is part of the cashbook collection now (one row per movement).
const KhataEntry = require('../models/CashbookEntry').EmployeeLedgerEntry;
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
 * Read the GPS fix a client sent with a filing.
 *
 * Best-effort by design: a refused location permission, a phone indoors with no
 * fix, a browser that denies it — none of those should stop somebody recording
 * money they have already spent. Absent is a legitimate answer, and an absent
 * location is more honest than a fabricated one.
 * @param {object} body - req.body (multipart, so everything arrives as a string).
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

/**
 * Allowlist mapper for a ledger entry. A field not named here never reaches a
 * client, however it happens to be stored.
 *
 * `viewer` is the user the payload is being built FOR, and it exists for one
 * field: where the employee was standing when they filed the expense. That is
 * for SuperAdmins alone — not the accounts team, not the employee's manager,
 * not the employee. Passing no viewer therefore means "show nobody", so a call
 * site that has not thought about it leaks nothing by omission.
 */
const publicEntry = (e, viewer) => ({
  _id: e._id,
  code: e.code,
  employee: e.employee && e.employee.firstName
    ? { _id: e.employee._id, name: `${e.employee.firstName} ${e.employee.lastName || ''}`.trim(), email: e.employee.email }
    : (e.employee?._id || e.employee || null),
  // Which expense book this was filed under. Null for anything that moves the
  // wallet itself — an advance, a settlement, a reimbursement.
  // The API keeps calling this `khata` so existing clients are unaffected; the
  // stored field is `expenseBook` since the two ledgers merged.
  khata: e.expenseBook?._id || e.expenseBook || null,
  khataName: e.expenseBook?.name || undefined,
  direction: e.direction,
  type: e.movement,
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
  cashAccount: e.account?._id || e.account || null,
  cashAccountName: e.account?.name || undefined,
  // The row IS the cashbook row now, so it points at itself rather than at a
  // separate mirrored entry. Legacy rows may still carry the old link.
  cashbookEntry: e.cashbookEntry || (e.affectsCompanyCash ? e._id : null),
  raisedByEmployee: e.raisedByEmployee,
  balanceAfter: e.walletBalanceAfter,
  hasAttachment: !!e.attachment?.storagePath,
  // Has anybody on the company side actually looked at this expense? 'Approved'
  // does not answer that for an expense, which posts unreviewed — see the
  // KhataEntry schema. Until this is true the row is still correctable.
  confirmedByCompany: !!e.confirmedByCompany,
  confirmedAt: e.confirmedAt || null,
  confirmedBy: e.confirmedBy && e.confirmedBy.firstName
    ? { _id: e.confirmedBy._id, name: `${e.confirmedBy.firstName} ${e.confirmedBy.lastName || ''}`.trim() }
    : (e.confirmedBy?._id || e.confirmedBy || null),
  // Whether the row is still open to correction AT ALL. Whether the person
  // reading it may make that correction is a second question — the employee
  // also needs the book to be open, which only the khata list can answer — so
  // the two are kept apart rather than collapsed into one misleading flag.
  editable: ledger.expenseEditability(e).company,
  // The corrections already made, so nobody reviewing a figure has to wonder
  // whether it is the one that was originally filed.
  edits: (e.edits || []).map((x) => ({
    at: x.at, byEmployee: !!x.byEmployee, summary: x.summary,
  })),
  // Where it was filed from — SuperAdmin only, and only when one was captured.
  // Spread rather than set to null so the key is simply ABSENT for everyone
  // else: a client cannot show a field it never receives, which is why neither
  // app carries a role check of its own for this.
  ...(viewer?.role === 'SuperAdmin' && e.filedLocation?.lat != null
    ? { filedLocation: {
      lat: e.filedLocation.lat,
      lng: e.filedLocation.lng,
      accuracy: e.filedLocation.accuracy,
      at: e.filedLocation.at,
    } }
    : {}),
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
    pendingReimbursement: 0, // claimed back, not yet paid out
    waitingCount: 0,
  };
  for (const e of entries) {
    const amt = Number(e.amount) || 0;
    if (e.status === 'Approved') {
      if (e.direction === 'to_employee') s.advanced += amt;
      else if (e.movement === 'expense') s.spent += amt;
      else s.returned += amt;
    } else if (e.status === 'AwaitingApproval' || e.status === 'Pending') {
      s.waitingCount += 1;
      if (e.direction === 'to_employee') {
        // A claim is money coming back, not an advance going out; folding the
        // two together would offer to pay somebody twice.
        if (e.movement === 'reimbursement') s.pendingReimbursement += amt;
        else if (e.status === 'AwaitingApproval') s.awaitingAdvance += amt;
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
    .populate('account', 'name')
    .populate('expenseBook', 'name')
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
      // What they could ask the company for right now: everything the wallet
      // has gone negative by, less anything already claimed and unpaid. Sent
      // from here so the button can be offered (and pre-filled) without the
      // client re-deriving a money figure.
      claimable: ledger.round2(Math.max(0, -(wallet.balance || 0) - sums.pendingReimbursement)),
    },
    // Whether a request of theirs will need an executive's sanction, so the
    // form can say so before they send it rather than after. A CEO/MD/Backend
    // sanctions their own — theirs goes straight to accounts.
    approvalRequired: ['CEO', 'MD', 'SuperAdmin'].includes(req.user.role)
      ? false
      : await advanceApprovalRequired(),
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

  // A CEO/MD (or the Backend) is the sanctioning authority — there is nobody
  // above them to approve their own advance, so it skips the executive gate and
  // goes straight to the accounts team (the Account Manager) to be paid out.
  const isSelfApprover = ['CEO', 'MD', 'SuperAdmin'].includes(req.user.role);
  const needsExec = !isSelfApprover && await advanceApprovalRequired();

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
 * IT POSTS IMMEDIATELY, and the company REJECTS rather than approves. Money the
 * employee is already holding has already been spent — the purchase happened at
 * the shop, and no amount of queueing un-buys it. Parking the record only made
 * the wallet lie about what was left in their pocket until somebody got round to
 * it. So the entry posts on the spot and the company reviews it afterwards,
 * reversing anything that should not stand (see reverseEntry).
 *
 * THE RECEIPT IS THEREFORE MANDATORY. It is the only control left once the
 * approval step is gone: nothing else stands between "I spent ₹5,000" and the
 * wallet dropping by ₹5,000. Checked BEFORE the entry posts, so a missing bill
 * can never leave a posted row with no evidence behind it.
 * @route POST /api/khata/me/expense
 * @param {string} req.body.khata - Which book it belongs to.
 * @param {number} req.body.amount
 * @param {string} req.body.purpose - What was bought.
 * @param {file} req.file - The bill; REQUIRED (multer field 'receipt').
 * @returns {{entry: object, message: string}} 201
 */
const recordMyExpense = asyncHandler(async (req, res) => {
  const amount = toNum(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) bad(res, 'Enter how much you spent');
  const purpose = String(req.body.purpose || '').trim();
  if (!purpose) bad(res, 'Say what you spent it on');
  // Before anything posts — see above. An expense with no bill behind it is the
  // one thing this flow cannot allow, now that it self-approves.
  if (!req.file) bad(res, 'Attach the bill or receipt — it is required for an expense.');

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
    // Where they were when they filed it. Kept for SuperAdmins only — see
    // parseFiledLocation and the KhataEntry schema.
    filedLocation: parseFiledLocation(req.body),
    // Posts on the spot; the company reverses it if it should not stand.
    autoApprove: true,
    raisedByEmployee: true,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  await attachReceipt(entry, req.file);

  const wallet = await ledger.getOrCreateWallet(req.user._id);

  await notifyMany(await khataApproverIds(), {
    type: 'general',
    audience: 'admin',
    title: 'Expense recorded against an advance',
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim()
      + ` spent ₹${amount.toLocaleString('en-IN')} on "${khata.name}" — ${purpose}. `
      + 'It has come off their advance; reject it if it should not stand.',
    link: '/admin/khata',
  });

  res.status(201).json({
    entry: publicEntry(entry),
    khata: publicKhata(khata),
    wallet: publicWallet(wallet),
    message: `Recorded. ₹${ledger.round2(Math.abs(wallet.balance)).toLocaleString('en-IN')} `
      + `${wallet.balance < 0 ? 'is now owed to you' : 'left in your wallet'}.`,
  });
});

/**
 * Read the editable fields of an expense out of a request body.
 *
 * Only what was actually sent: an omitted field means "leave it alone", which
 * is what lets a screen send one changed figure without having to round-trip
 * every other value it never showed.
 * @param {object} body - req.body.
 * @param {object} res - For setting the status before throwing.
 * @returns {object} Changes for ledger.applyExpenseEdit.
 */
function expenseChanges(body, res) {
  const out = {};
  for (const field of ['purpose', 'category', 'referenceNo', 'khata', 'date']) {
    if (body[field] !== undefined && body[field] !== '') out[field] = body[field];
  }
  if (body.paymentMode !== undefined && body.paymentMode !== '') {
    if (!PAYMENT_MODES.includes(body.paymentMode)) bad(res, 'That is not a payment method we record');
    out.paymentMode = body.paymentMode;
  }
  if (body.amount !== undefined && body.amount !== '') {
    const amount = toNum(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) bad(res, 'Enter an amount greater than zero');
    out.amount = amount;
  }
  if (out.khata !== undefined && !isId(out.khata)) bad(res, 'That is not a khata we can file this under');
  return out;
}

/**
 * Swap the bill on an entry, deleting the one it replaces.
 *
 * The old file is removed only AFTER the new one is stored and the entry saved:
 * a failure part-way through leaves an entry with a bill that exists, never one
 * pointing at a file that has been deleted.
 * @param {object} entry - A saved KhataEntry document.
 * @param {object} [file] - Multer file; nothing happens without one.
 * @returns {Promise<boolean>} Whether a replacement actually happened.
 */
async function replaceReceipt(entry, file) {
  if (!file) return false;
  const previous = entry.attachment?.storagePath;
  await attachReceipt(entry, file);
  if (previous && previous !== entry.attachment?.storagePath) {
    await storage.remove(previous).catch(() => { /* the entry is what matters */ });
  }
  return true;
}

/**
 * Correct an expense you recorded, before the company has confirmed it.
 *
 * An expense posts the moment it is recorded — the purchase already happened —
 * which means the figure reaches the ledger before anybody has checked it. This
 * is the other half of that bargain: until the company confirms it, the person
 * who typed it can fix it. The amount goes on counting against their advance
 * throughout, at whatever it currently says; an edit is a correction to a live
 * figure, not a new request waiting to take effect.
 *
 * Two things end the window: the company confirming the expense, and the book
 * being closed. See ledger.expenseEditability for why.
 * @route PUT /api/khata/me/expenses/:id
 * @param {number} [req.body.amount] [req.body.purpose] [req.body.khata] etc.
 * @param {file} [req.file] - A replacement bill (multer field 'receipt').
 * @returns {{entry: object, wallet: object, khata: object, message: string}}
 */
const updateMyExpense = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) bad(res, 'Invalid entry');
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'That entry no longer exists', 404);
  if (String(entry.employee) !== String(req.user._id)) bad(res, 'That entry is not yours', 403);

  const book = entry.expenseBook ? await EmployeeKhata.findById(entry.expenseBook) : null;
  const rights = ledger.expenseEditability(entry, book);
  if (!rights.employee) {
    bad(res, rights.reason
      || 'This expense was recorded by the company, so only they can change it.');
  }

  const changes = expenseChanges(req.body, res);
  changes.receiptReplaced = await replaceReceipt(entry, req.file);

  const { entry: saved, wallet, khata, changed, summary } = await ledger.applyExpenseEdit(
    entry, changes, req.user, { asEmployee: true }
  );

  if (changed) {
    await notifyMany(await khataApproverIds(), {
      type: 'general',
      audience: 'admin',
      title: 'Expense corrected before confirmation',
      body: `${req.user.firstName} ${req.user.lastName || ''}`.trim()
        + ` changed ${saved.code || 'an expense'} — ${summary}. It is still waiting to be confirmed.`,
      link: '/admin/khata',
    });
  }

  res.json({
    entry: publicEntry(saved),
    wallet: publicWallet(wallet),
    khata: khata ? publicKhata(khata) : null,
    message: changed ? 'Updated. It still counts against your advance.' : 'Nothing was changed.',
  });
});

/**
 * Ask the company to pay back what it owes you.
 *
 * The mirror image of returning unspent cash, and it only exists when the
 * wallet has gone NEGATIVE — the employee spent past their advance, so the
 * company is holding their money rather than the other way round. Without this
 * they had no way to ask for it: every other self-service action moves money
 * towards the company.
 *
 * Deliberately NOT behind the CEO/MD gate. That gate asks "should this person
 * be given company money?", which is not the question here: this money has
 * already been spent on the company's behalf and each expense behind it was
 * confirmed one at a time. It parks with the accounts team, who choose the
 * account to pay it from — the same second gate every payout passes.
 * @route POST /api/khata/me/reimbursement
 * @param {number} [req.body.amount] - Defaults to everything outstanding.
 * @param {string} [req.body.purpose]
 * @returns {{entry: object, message: string}} 201
 */
const requestReimbursement = asyncHandler(async (req, res) => {
  const wallet = await ledger.getOrCreateWallet(req.user._id, req.user);
  const owed = ledger.round2(-(wallet.balance || 0));
  if (!(owed > 0)) {
    bad(res, 'The company does not owe you anything right now. Record your expenses first — '
      + 'you can claim once they take you past your advance.');
  }

  // Anything already asked for and not yet paid. Without this the same debt
  // could be claimed twice over simply by submitting the form again before the
  // accounts team had got to the first one.
  const waiting = await KhataEntry.aggregate([
    {
      $match: {
        employee: new mongoose.Types.ObjectId(String(req.user._id)),
        type: 'reimbursement',
        status: { $in: ['Pending', 'AwaitingApproval'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const pending = ledger.round2(waiting[0]?.total || 0);
  const claimable = ledger.round2(owed - pending);
  if (!(claimable > 0)) {
    bad(res, `You have already claimed ₹${pending.toLocaleString('en-IN')}, which covers everything outstanding. `
      + 'Wait for the company to settle it.');
  }

  // Claiming the lot is the normal case, so an omitted amount means "all of it".
  const asked = req.body.amount === undefined || req.body.amount === '' ? claimable : toNum(req.body.amount);
  if (!Number.isFinite(asked) || asked <= 0) bad(res, 'Enter how much you are claiming');
  if (ledger.round2(asked) > claimable) {
    bad(res, `You can claim up to ₹${claimable.toLocaleString('en-IN')}`
      + (pending ? ` — ₹${pending.toLocaleString('en-IN')} of what you are owed is already waiting on the company.` : '.'));
  }

  const { entry } = await ledger.postEntry({
    employee: req.user._id,
    direction: 'to_employee',
    type: 'reimbursement',
    amount: asked,
    purpose: String(req.body.purpose || 'Settlement of what the company owes').trim(),
    category: req.body.category || 'Reimbursement',
    paymentMode: req.body.paymentMode || 'Cash',
    date: parseDate(req.body.date) || new Date(),
    // The employee names no account: the accounts team decides which one pays.
    autoApprove: false,
    raisedByEmployee: true,
    idempotencyKey: req.body.idempotencyKey,
  }, req.user);

  await notifyMany(await khataApproverIds(), {
    type: 'general',
    audience: 'admin',
    title: 'Settlement claimed',
    body: `${req.user.firstName} ${req.user.lastName || ''}`.trim()
      + ` is owed ₹${asked.toLocaleString('en-IN')} for spending past their advance, and has asked to be paid it back.`,
    link: '/admin/khata',
  });

  res.status(201).json({
    entry: publicEntry(entry),
    message: 'Claim sent. The company will pay it out once they confirm it.',
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
  if (isId(req.query.khata)) filter.expenseBook = req.query.khata;

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) { to.setHours(23, 59, 59, 999); filter.date.$lte = to; }
  }
  if (req.query.status) filter.status = req.query.status;

  const entries = await KhataEntry.find(filter)
    .populate('account', 'name')
    .populate('expenseBook', 'name')
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
    // The viewer decides whether the filing locations travel — SuperAdmin only.
    entries: entries.map((e) => publicEntry(e, req.user)),
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
  if (isId(req.query.cashAccount)) filter.account = req.query.cashAccount;
  if (isId(req.query.khata)) filter.expenseBook = req.query.khata;
  // The expense review queue: everything that posted without anybody checking
  // it. Rows written before this flag existed carry no `confirmedByCompany` at
  // all, so "not confirmed" has to mean false OR missing, not `false`.
  if (req.query.confirmed === 'false') filter.confirmedByCompany = { $ne: true };
  else if (req.query.confirmed === 'true') filter.confirmedByCompany = true;

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
    .populate('expenseBook', 'name')
    .populate('account', 'name')
    .populate('reviewedBy', 'firstName lastName')
    .populate('execApprovedBy', 'firstName lastName role')
    .sort({ date: -1, createdAt: -1 })
    .limit(limit);

  res.json({ count: entries.length, entries: entries.map((e) => publicEntry(e, req.user)) });
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
    .populate('expenseBook', 'name')
    .populate('account', 'name')
    .populate('execApprovedBy', 'firstName lastName role')
    .sort({ createdAt: 1 });
  res.json({ count: entries.length, entries: entries.map((e) => publicEntry(e, req.user)) });
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
    .populate('expenseBook', 'name')
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
 * Correct an employee's expense on their behalf, before it is confirmed.
 *
 * The company's half of the same window the employee has (see updateMyExpense).
 * It is wider in two ways, both deliberate: the company may correct an expense
 * IT recorded as well as one the employee filed, and a closed book stops the
 * employee editing but not them — closing is the company taking the figures
 * over, not sealing them against their own owner.
 *
 * Confirming is the thing that ends it for everybody.
 * @route PUT /api/khata/entries/:id  (khata.manage)
 * @param {file} [req.file] - A replacement bill (multer field 'receipt').
 * @returns {{entry: object, wallet: object, khata: object, message: string}}
 */
const updateEntry = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) bad(res, 'Invalid entry');
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'That entry no longer exists', 404);

  const book = entry.expenseBook ? await EmployeeKhata.findById(entry.expenseBook) : null;
  const rights = ledger.expenseEditability(entry, book);
  // Everyone loses edit rights once the company confirms an expense — it must be
  // reversed instead. The one exception: a SuperAdmin (the Backend) can still
  // correct a confirmed expense in place, so a mistake caught after sign-off does
  // not force a reversal. A reversed entry stays untouchable.
  const superAdminAfterConfirm = req.user.role === 'SuperAdmin'
    && entry.movement === 'expense' && entry.status === 'Approved'
    && !entry.reversedBy && entry.confirmedByCompany;
  if (!rights.company && !superAdminAfterConfirm) bad(res, rights.reason || 'This entry can no longer be edited.');

  const changes = expenseChanges(req.body, res);
  changes.receiptReplaced = await replaceReceipt(entry, req.file);

  const { entry: saved, wallet, khata, changed, summary } = await ledger.applyExpenseEdit(
    entry, changes, req.user, { asEmployee: false }
  );

  if (changed) {
    await notify({
      recipient: saved.employee,
      type: 'general',
      audience: 'employee',
      title: 'Your expense was corrected',
      body: `${saved.code || 'An expense'} was changed by the company — ${summary}. `
        + `You now have ₹${Math.abs(wallet.balance).toLocaleString('en-IN')} in hand.`,
      link: '/employee/khata',
    });
  }

  res.json({
    entry: publicEntry(saved),
    wallet: publicWallet(wallet),
    khata: khata ? publicKhata(khata) : null,
    message: changed ? 'Updated.' : 'Nothing was changed.',
  });
});

/**
 * Confirm an employee's expense — the company has looked at it and it stands.
 *
 * Moves no money: the row counted the moment it was recorded. What it changes is
 * that nobody may edit it any more, on either side. It is the close of the
 * window that recording-on-the-spot opens, and the counterpart of rejecting it
 * (which is a reversal — see reverseEntry).
 * @route PATCH /api/khata/entries/:id/confirm  (khata.manage)
 * @param {string} [req.body.note] - Shown to the employee.
 * @returns {{entry: object, message: string}}
 */
const confirmEntry = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) bad(res, 'Invalid entry');
  const entry = await KhataEntry.findById(req.params.id);
  if (!entry) bad(res, 'That entry no longer exists', 404);

  const saved = await ledger.confirmExpense(entry, req.user, req.body.note);

  await notify({
    recipient: saved.employee,
    type: 'general',
    audience: 'employee',
    title: 'Expense confirmed',
    body: `₹${saved.amount.toLocaleString('en-IN')} (${saved.code || 'your expense'}) has been checked and accepted`
      + `${req.body.note ? `: ${String(req.body.note).slice(0, 200)}` : '.'}`
      + ' It can no longer be edited.',
    link: '/employee/khata',
  });

  res.json({ entry: publicEntry(saved), message: 'Confirmed. It is now locked.' });
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
    if (entry.affectsCompanyCash && entry.account) {
      const { rights } = await requireOperableAccount(req.user, entry.account, res);
      if (!rights.canApprove) bad(res, 'Only an approver on this account can reverse a posted entry.', 403);
    } else if (entry.movement === 'expense') {
      // Rejecting an employee's expense. Any khata operator may do it: an
      // expense self-approves, so this reversal IS the company's review of it,
      // and reserving that for a SuperAdmin would leave the accounts team
      // watching wrong entries they could not correct. Safe because no company
      // cash moves either way — it only restores the employee's wallet.
      if (!hasPermission(req.user, 'khata.manage')) {
        bad(res, 'You do not have permission to reject khata expenses', 403);
      }
    } else {
      bad(res, 'Only a Super Admin can reverse this entry.', 403);
    }
  }

  const { original, reversal, wallet, khata } = await ledger.reverseEntry(entry, req.user, req.body.reason);

  // An expense that self-approved was never "approved" by anybody, so calling
  // its reversal a reversal would puzzle the employee. From their side it was
  // simply rejected, and the money is back in their wallet.
  const wasExpense = original.type === 'expense';
  await notify({
    recipient: original.employee,
    type: 'general',
    audience: 'employee',
    title: wasExpense ? 'Expense rejected' : 'Khata entry reversed',
    body: wasExpense
      ? `Your ₹${original.amount.toLocaleString('en-IN')} expense (${original.code || 'entry'}) was rejected: `
        + `${req.body.reason}. It has been added back to your advance.`
      : `${original.code || 'An entry'} of ₹${original.amount.toLocaleString('en-IN')} was reversed: ${req.body.reason}`,
    link: '/employee/khata',
  });

  res.json({
    original: publicEntry(original),
    reversal: publicEntry(reversal),
    wallet: publicWallet(wallet),
    khata: khata ? publicKhata(khata) : null,
    message: wasExpense
      ? 'Rejected. The expense and its reversal both stay on the record.'
      : 'Reversed. Both entries stay on the record.',
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

  // Closing is the COMPANY's act and only theirs — this route is behind
  // `khata.manage`, and there is no self-service equivalent. It is how finance
  // says "that job is done": the book stops taking entries, the employee stops
  // being able to correct what is in it, and the company keeps both.
  let closureChanged = null;
  if (req.body.isActive !== undefined) {
    const nextActive = req.body.isActive === true || req.body.isActive === 'true';
    // The fallback book has to stay open, or self-service has nowhere to file
    // an expense from somebody with no other book.
    if (!nextActive && khata.isDefault) {
      bad(res, 'This is the default khata and cannot be closed. Make another one the default first.');
    }
    if (nextActive !== khata.isActive) closureChanged = nextActive ? 'reopened' : 'closed';
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

  // Closing takes two things away from the employee at once — filing into the
  // book, and correcting what is already in it — so it is told, not left to be
  // discovered the next time they try.
  if (closureChanged) {
    await notify({
      recipient: khata.employee,
      type: 'general',
      audience: 'employee',
      title: closureChanged === 'closed' ? 'A khata was closed' : 'A khata was re-opened',
      body: closureChanged === 'closed'
        ? `"${khata.name}" has been closed by the company. Its record stays on your statement, but you `
          + 'can no longer add to it or change the expenses in it.'
        : `"${khata.name}" is open again. You can record expenses against it.`,
      link: '/employee/khata',
    });
  }

  res.json({
    khata: publicKhata(khata),
    message: closureChanged === 'closed' ? `"${khata.name}" is closed.`
      : closureChanged === 'reopened' ? `"${khata.name}" is open again.` : 'Saved',
  });
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
      .populate('expenseBook', 'name')
      .populate('account', 'name')
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
      khata: e.expenseBook?.name || '',
      type: e.movement,
      purpose: e.purpose || e.category || '',
      given: e.direction === 'to_employee' ? e.amount : null,
      returned: e.direction === 'from_employee' ? e.amount : null,
      balanceAfter: e.status === 'Approved' ? e.balanceAfter : null,
      account: e.account?.name || '',
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

// ---------------------------------------------------------------------------
// Statement PDF
// ---------------------------------------------------------------------------

/**
 * How many bills one statement embeds, and how many bytes of them.
 *
 * A year of a busy site book is a few hundred phone photos at up to 5 MB each —
 * embedding all of them would build a document nobody can email, and would hold
 * the request (and that much memory) open while it did. There is no image
 * library in this service to downscale with, so the only honest guard is to stop
 * at a budget.
 *
 * BOTH caps are needed: the count bounds the page-turning, the byte budget
 * bounds the memory, and either alone lets the other run away. Whatever is left
 * off is COUNTED and printed on the statement — a document that quietly drops
 * bills reads exactly like one that had none.
 */
const RECEIPT_PAGE_CAP = 60;
const RECEIPT_BYTES_CAP = 24 * 1024 * 1024;

/** Rows a statement is built from: the posted money, plus the cancelled rows
 *  it keeps on the record. Reversed rows print greyed and count for nothing —
 *  see services/khataStatementPdf.js. */
const STATEMENT_STATUSES = ['Approved', 'Reversed'];

/**
 * Gather everything one statement needs and render it.
 *
 * Shared by the operator route and the employee's own-statement route; the
 * two differ only in who they are allowed to ask about, which the callers
 * settle before they get here.
 * @param {object} req
 * @param {object} res
 * @param {string} employeeId
 * @sideEffects Reads GridFS for the logo and every embedded bill; writes the PDF to `res`.
 */
async function streamStatement(req, res, employeeId) {
  const employee = await User.findById(employeeId).select(USER_FIELDS);
  if (!employee) bad(res, 'Employee not found', 404);

  // A named book must belong to the person the statement is about, or an id
  // guessed from another employee's page would print their spending here.
  let khata = null;
  if (req.query.khata) {
    if (!isId(req.query.khata)) bad(res, 'Invalid khata', 400);
    khata = await EmployeeKhata.findById(req.query.khata).lean();
    if (!khata || String(khata.employee) !== String(employeeId)) bad(res, 'Khata not found', 404);
  }

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to);
  if (to) to.setHours(23, 59, 59, 999);

  const base = { employee: employeeId, status: { $in: STATEMENT_STATUSES } };
  if (khata) base.expenseBook = khata._id;

  const inRange = { ...base };
  if (from || to) {
    inRange.date = {};
    if (from) inRange.date.$gte = from;
    if (to) inRange.date.$lte = to;
  }

  const [entries, before, wallet, profile, branding, settings] = await Promise.all([
    KhataEntry.find(inRange).populate('expenseBook', 'name').populate('account', 'name')
      .sort({ date: 1, createdAt: 1 }).limit(2000).lean(),
    // Everything that happened BEFORE the window, so the statement opens on the
    // figure the previous one closed at instead of at zero.
    from
      ? KhataEntry.find({ ...base, date: { $lt: from } }).select('direction amount status').lean()
      : Promise.resolve([]),
    ledger.getOrCreateWallet(employeeId, req.user),
    EmployeeProfile.findOne({ user: employeeId }).select('employeeCode designation department').lean(),
    require('../services/branding').getBranding().catch(() => ({ logo: null })),
    Setting.getSettings().catch(() => null),
  ]);

  // The renderer takes flat names rather than populated sub-documents, so it can
  // be driven from a fixture in scripts/testKhataLedger.js without a database
  // behind it.
  const rows = entries.map((e) => ({
    ...e,
    khataName: e.expenseBook?.name || '',
    cashAccountName: e.account?.name || '',
  }));

  const { renderKhataStatement, movement } = require('../services/khataStatementPdf');
  const scope = khata ? 'khata' : 'wallet';
  const opening = ledger.round2(
    (khata ? 0 : wallet.openingBalance || 0)
    + before.filter((e) => e.status !== 'Reversed').reduce((sum, e) => sum + movement(e, scope), 0)
  );

  // Bills are read one at a time rather than in one Promise.all: sixty GridFS
  // downloads fired at once is a burst the connection pool does not need, and
  // the loop stops the moment the cap is reached.
  const receipts = new Map();
  let receiptBytes = 0;
  let omittedReceipts = 0;
  for (const e of rows) {
    if (!e.attachment?.storagePath) continue;
    if (receipts.size >= RECEIPT_PAGE_CAP || receiptBytes >= RECEIPT_BYTES_CAP) {
      omittedReceipts += 1;
      continue;
    }
    try {
      const buffer = await storage.readBuffer(e.attachment.storagePath);
      if (!buffer) { omittedReceipts += 1; continue; }
      receipts.set(String(e._id), { buffer, name: e.attachment.name || '' });
      receiptBytes += buffer.length;
    } catch (_) {
      // A missing or unreadable bill must not sink the statement — but it is
      // still a bill the reader was expecting to see.
      omittedReceipts += 1;
    }
  }

  const pdf = await renderKhataStatement({
    company: require('../config/company'),
    logo: branding.logo || null,
    employee: {
      name: `${employee.firstName} ${employee.lastName || ''}`.trim(),
      employeeCode: profile?.employeeCode,
      designation: profile?.designation,
      department: profile?.department,
    },
    khata: khata ? { name: khata.name, note: khata.note } : null,
    range: { from, to },
    opening,
    entries: rows,
    receipts,
    omittedReceipts,
    footer: {
      helpline: settings?.documentFooter?.helpline || '',
      note: settings?.documentFooter?.note || '',
    },
    generatedAt: new Date(),
  });

  const slug = (khata ? khata.name : `${employee.firstName}-all-khatas`)
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'khata';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="khata-statement-${slug}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
}

/**
 * One employee's khata (or whole wallet) as a statement PDF.
 *
 * Sits under `khata.manage` with the rest of the operator views rather than
 * behind the export grant: this is one person's book laid out for reading, not
 * the whole company's ledger as data, which is the thing `khataExportAccess`
 * exists to gate.
 * @route GET /api/khata/employees/:employeeId/statement.pdf  (khata.manage)
 * @param {string} [req.query.khata] - one expense book; omitted prints every book
 * @param {string} [req.query.from] - inclusive
 * @param {string} [req.query.to] - inclusive
 * @returns {binary} application/pdf
 */
const statementPdf = asyncHandler(async (req, res) => {
  if (!isId(req.params.employeeId)) bad(res, 'Invalid employee', 400);
  await streamStatement(req, res, req.params.employeeId);
});

/**
 * The same statement, for the signed-in employee's own khatas.
 *
 * No permission beyond being logged in: it is their money and their bills, and
 * the employee id is taken from the token rather than the URL so there is
 * nothing to tamper with.
 * @route GET /api/khata/me/statement.pdf
 * @returns {binary} application/pdf
 */
const myStatementPdf = asyncHandler(async (req, res) => {
  await streamStatement(req, res, req.user._id);
});

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
  getMyKhata, requestAdvance, recordMyExpense, updateMyExpense, declareSettlement, requestReimbursement,
  // operator lists
  overview, listMyAccounts, listKhatas, getKhata, employeeOptions, listEntries, listPending,
  // executive sanction
  listAdvanceApprovals, decideAdvanceApproval,
  // money movement
  createEntry, approveEntry, rejectEntry, reverseEntry, updateEntry, confirmEntry,
  // settings
  createKhata, createMyKhata, updateKhataSettings, updateWalletSettings, recomputeWallet,
  // reports
  outstandingReport, sendSettleReminders, exportExcel, statementPdf, myStatementPdf,
  // account operators
  listOperators, setOperators,
  // receipts
  getReceipt,
};
