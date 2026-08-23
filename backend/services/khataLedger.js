/**
 * The employee cash-ledger engine — wallets, expense books, and the money rules.
 *
 * Everything that can change an employee's balance goes through here, so there
 * is exactly one place where the money rules live. Controllers validate input
 * and shape responses; they never do balance arithmetic themselves.
 *
 * THE SHAPE OF THE MODULE, in one paragraph. Each employee has ONE wallet
 * (EmployeeWallet) — the pot the company pays advances into. They also open as
 * many khatas (EmployeeKhata) as they like, which are expense books: folders
 * that say what the money went on. Spending is filed against a khata and comes
 * out of the wallet, so the remaining advance reads the same whichever book you
 * have open. Only expenses carry a khata; advances, settlements, reimbursements
 * and recoveries move the wallet on its own.
 *
 * Four guarantees this file exists to provide:
 *
 *  1. THE BALANCE CANNOT DRIFT. It is never incremented in place. After any
 *     change the employee's whole ledger is replayed from the opening balance
 *     and the result is written back, exactly as the cashbook does for cash
 *     accounts. A back-dated entry therefore also re-stamps every later running
 *     balance.
 *
 *  2. THE BOOKS ADD UP TO THE POT. A khata's `spent` is replayed from the same
 *     rows as the wallet, so "what is left" and "what it went on" can never
 *     tell two different stories.
 *
 *  3. COMPANY CASH AND THE EMPLOYEE LEDGER MOVE TOGETHER. An advance that
 *     leaves the petty-cash tin posts a CashbookEntry as well, cross-linked in
 *     both directions. Neither book can be updated without the other.
 *
 *  4. POSTED MONEY IS NEVER DELETED. Corrections are reversals — the original
 *     is marked Reversed and a mirror row is written against it, on both the
 *     wallet and the cashbook.
 *
 * SIGN RULE (repeated here because everything below depends on it):
 *   direction 'to_employee'   → wallet += amount   (they hold more of our cash)
 *   direction 'from_employee' → wallet -= amount   (they hold less of it)
 * A positive wallet means the employee is holding company money; a negative one
 * means they spent past the advance and the company owes them.
 */
const mongoose = require('mongoose');
const EmployeeKhata = require('../models/EmployeeKhata');
const { DEFAULT_KHATA_NAME } = require('../models/EmployeeKhata');
const EmployeeWallet = require('../models/EmployeeWallet');
const KhataEntry = require('../models/KhataEntry');
const { KHATA_TYPES } = require('../models/KhataEntry');
const CashAccount = require('../models/CashAccount');
const CashbookEntry = require('../models/CashbookEntry');
const User = require('../models/User');

/** Money is stored to 2 decimals; every computed figure goes through this. */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Cashbook category used for the company-cash leg of each khata movement. */
const CASH_CATEGORY = {
  advance: 'Employee Advance',
  settlement: 'Employee Settlement',
  reimbursement: 'Employee Reimbursement',
  reversal: 'Khata Reversal',
};

/**
 * A khata entry's signed effect on the balance, from the company's side.
 * @param {{direction: string, amount: number}} entry
 * @returns {number} Positive when the employee owes the company more.
 */
const signedAmount = (entry) => (entry.direction === 'to_employee' ? entry.amount : -entry.amount);

/**
 * Does this kind of movement belong to an expense book, or to the wallet alone?
 *
 * The one question the whole wallet/khata split turns on, so it is answered
 * here and nowhere else. Spending is filed under a book; money entering or
 * leaving the pot is not.
 * @param {string} type - A KhataEntry.ENTRY_TYPES value.
 * @returns {boolean}
 */
const needsKhata = (type) => KHATA_TYPES.includes(type);

/**
 * Human name for a user doc or id, for the `party` column on the cashbook leg.
 * @param {object|null} user - A populated User doc, or null.
 * @returns {string}
 */
const nameOf = (user) => (user && user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : 'Employee');

// ---------------------------------------------------------------------------
// Wallet and khata lookup
// ---------------------------------------------------------------------------

/**
 * Fetch an employee's wallet, opening it on first use.
 *
 * Lazily rather than one-per-employee up front, because most staff never hold
 * company cash and an empty wallet each would only clutter the outstanding
 * list.
 * @param {string|import('mongoose').Types.ObjectId} employeeId
 * @param {object} [actor] - The acting user, recorded as creator on first open.
 * @returns {Promise<object>} The EmployeeWallet document.
 */
async function getOrCreateWallet(employeeId, actor) {
  const existing = await EmployeeWallet.findOne({ employee: employeeId });
  if (existing) return existing;
  try {
    return await EmployeeWallet.create({ employee: employeeId, createdBy: actor?._id });
  } catch (err) {
    // Unique index on `employee` — two concurrent first entries raced. The
    // other one won; use it.
    if (err.code === 11000) return EmployeeWallet.findOne({ employee: employeeId });
    throw err;
  }
}

/**
 * Repair anything a database carried over from before multi-khata, once per
 * process. Covers three things, all of which are otherwise silent failures.
 *
 * `EmployeeKhata.employee` used to be `unique: true`. Taking that out of the
 * schema does NOT take it out of MongoDB — Mongoose only ever creates indexes,
 * it never drops them. Left in place, it rejects an employee's SECOND khata
 * with a duplicate-key error that looks like "this name is taken" and is
 * nothing of the kind.
 *
 * scripts/migrateMultiKhata.js does all of this deliberately, but the module
 * should not be quietly broken on a database where nobody has run it — so it
 * heals itself. Every step is narrow and idempotent: the index drop matches ONLY
 * a unique index keyed exactly `{ employee: 1 }`, the naming touches only khatas
 * with no name at all, and the default flag is set only for employees who have
 * none. Each logs when it acts.
 * @returns {Promise<void>} Resolves once the repair has run (memoized).
 */
let integrityCheck = null;
function ensureKhataIntegrity() {
  if (integrityCheck) return integrityCheck;
  integrityCheck = (async () => {
    const collection = EmployeeKhata.collection;

    // (a) The obsolete unique index.
    const indexes = await collection.indexes();
    const stale = indexes.find((i) => i.unique
      && Object.keys(i.key).length === 1
      && i.key.employee === 1);
    if (stale) {
      await collection.dropIndex(stale.name);
      console.log(`khata: dropped the obsolete unique index "${stale.name}" on { employee: 1 } — `
        + 'employees can now hold more than one khata.');
    }

    // (b) Khatas written before `name` existed. They render as a nameless row
    // with a balance on it, which is worse than useless — you cannot tell what
    // the money is for. Named rather than left blank, and only where absent, so
    // this never touches a khata somebody has deliberately named.
    const unnamed = await collection.updateMany(
      { $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] },
      { $set: { name: DEFAULT_KHATA_NAME } }
    );
    if (unnamed.modifiedCount) {
      console.log(`khata: named ${unnamed.modifiedCount} khata(s) "${DEFAULT_KHATA_NAME}" — they predate the name field.`);
    }

    // (c) Employees with no default book. Self-service falls back to their
    // oldest when the flag is missing, so nothing is broken — but the flag is
    // what the UI marks, and what stops the fallback book being closed.
    const missing = await EmployeeKhata.aggregate([
      { $group: { _id: '$employee', hasDefault: { $max: { $cond: ['$isDefault', 1, 0] } } } },
      { $match: { hasDefault: 0 } },
    ]);
    for (const row of missing) {
      const oldest = await EmployeeKhata.findOne({ employee: row._id }).sort({ createdAt: 1 });
      if (oldest) {
        oldest.isDefault = true;
        await oldest.save();
      }
    }
    if (missing.length) {
      console.log(`khata: flagged a default khata for ${missing.length} employee(s).`);
    }
  })().catch((err) => {
    // Never block a khata operation over a repair. If this failed (no
    // permission, a racing process), the caller still works and the duplicate-key
    // handler gives a precise diagnosis where it matters.
    console.error('khata: integrity repair failed:', err.message);
  });
  return integrityCheck;
}

/**
 * Fetch the khata an employee's money falls to when none is named, opening it
 * on first use.
 *
 * An employee may hold several khatas, but self-service has to work before
 * anyone has organised anything — somebody asking for ₹500 should not first be
 * made to create a book. So the first khata is opened lazily, named "General",
 * and flagged `isDefault`.
 *
 * Lazily rather than one-per-employee up front, because most staff never hold
 * company cash and an empty ledger each would only clutter the outstanding list.
 * @param {string|import('mongoose').Types.ObjectId} employeeId
 * @param {object} [actor] - The acting user, recorded as creator on first open.
 * @returns {Promise<object>} The EmployeeKhata document.
 */
async function getOrCreateDefaultKhata(employeeId, actor) {
  await ensureKhataIntegrity();
  // Prefer the flagged default; fall back to their oldest, which covers khatas
  // created before the flag existed and any where it was somehow cleared.
  const existing = await EmployeeKhata.findOne({ employee: employeeId, isDefault: true })
    || await EmployeeKhata.findOne({ employee: employeeId }).sort({ createdAt: 1 });
  if (existing) return existing;

  try {
    return await EmployeeKhata.create({
      employee: employeeId,
      name: DEFAULT_KHATA_NAME,
      isDefault: true,
      createdBy: actor?._id,
    });
  } catch (err) {
    // Compound unique index on {employee, name} — two concurrent first entries
    // raced. The other one won; use it.
    if (err.code === 11000) return EmployeeKhata.findOne({ employee: employeeId, name: DEFAULT_KHATA_NAME });
    throw err;
  }
}

/**
 * Resolve which expense book a spend belongs to, and confirm it can take entries.
 *
 * Every posting path goes through this so the rules are stated once: a named
 * book must exist, must belong to the employee whose money is moving, and must
 * still be open. Naming nothing falls back to their default.
 *
 * The ownership check is the important one — without it, a request naming
 * somebody else's khata id would file one person's spending under another
 * person's book.
 * @param {string|import('mongoose').Types.ObjectId} employeeId
 * @param {string|import('mongoose').Types.ObjectId} [khataId] - Omit for the default.
 * @param {object} [actor] - The acting user.
 * @returns {Promise<object>} The EmployeeKhata document.
 * @throws {Error} `.statusCode = 400/404` if unknown, closed, or not theirs.
 */
async function resolveKhata(employeeId, khataId, actor) {
  if (!khataId) {
    const khata = await getOrCreateDefaultKhata(employeeId, actor);
    if (!khata.isActive) {
      const err = new Error(`"${khata.name}" is closed and cannot take new entries.`);
      err.statusCode = 400;
      throw err;
    }
    return khata;
  }

  const khata = await EmployeeKhata.findById(khataId);
  if (!khata) {
    const err = new Error('That khata no longer exists.');
    err.statusCode = 404;
    throw err;
  }
  if (String(khata.employee) !== String(employeeId)) {
    const err = new Error('That khata belongs to a different employee.');
    err.statusCode = 400;
    throw err;
  }
  if (!khata.isActive) {
    const err = new Error(`"${khata.name}" is closed and cannot take new entries.`);
    err.statusCode = 400;
    throw err;
  }
  return khata;
}

/**
 * Every expense book an employee holds, with the default first.
 * @param {string|import('mongoose').Types.ObjectId} employeeId
 * @param {boolean} [includeClosed=false]
 * @returns {Promise<object[]>}
 */
async function listKhatasOf(employeeId, includeClosed = false) {
  const filter = { employee: employeeId };
  if (!includeClosed) filter.isActive = true;
  return EmployeeKhata.find(filter).sort({ isDefault: -1, name: 1 });
}

/**
 * Split a set of wallets into the two figures people actually ask for.
 *
 * NOT a net across people. Somebody holding ₹5,000 of our cash while we owe
 * somebody else ₹2,000 is two separate facts, and netting them to "₹3,000
 * receivable" hides the payable entirely — which is how a company forgets to
 * pay somebody back. So both sides are carried in full, with the net alongside
 * for the one-line summary.
 * @param {Array<{balance: number}>} wallets
 * @returns {{get: number, give: number, net: number}} `get` = held by staff, `give` = owed to them.
 */
function splitTotals(wallets = []) {
  let get = 0;
  let give = 0;
  for (const k of wallets) {
    const balance = Number(k.balance) || 0;
    if (balance > 0) get += balance;
    else if (balance < 0) give += Math.abs(balance);
  }
  return { get: round2(get), give: round2(give), net: round2(get - give) };
}

// ---------------------------------------------------------------------------
// Balance recomputation — the never-drift guarantee
// ---------------------------------------------------------------------------

/**
 * Walk a list of entries and produce the running balance after each one.
 *
 * The whole of the money arithmetic, with no database in sight, so it can be
 * exercised directly by scripts/testKhataLedger.js. recomputeWalletBalance is
 * just this function plus the loading and saving around it.
 * @param {number} openingBalance - Where the ledger starts.
 * @param {Array<{direction: string, amount: number}>} entries - In posting order.
 * @returns {{closing: number, running: number[]}} The final balance, and the balance after each entry.
 */
function replayBalance(openingBalance, entries) {
  let running = round2(openingBalance || 0);
  const trail = [];
  for (const entry of entries) {
    running = round2(running + signedAmount(entry));
    trail.push(running);
  }
  return { closing: running, running: trail };
}

/**
 * Replay an employee's whole ledger and write back the wallet balance, plus the
 * running-balance column on every row.
 *
 * Called after ANY change to that employee's entries. Deliberately a full
 * replay rather than a delta: a back-dated or reversed entry changes the
 * running balance of every row after it, and an incremental update would leave
 * those stale. Ledgers are per-employee and short — a few hundred rows at most
 * — so the cost is trivial next to the risk of a wrong number.
 *
 * Note this replays the whole PERSON, not one book: the wallet is the only
 * thing that carries a balance, and every row of theirs moves it whichever book
 * it was filed under.
 *
 * Only 'Approved' rows count. AwaitingApproval and Pending ones have not
 * happened yet; Rejected ones never did; Reversed ones did but have been
 * cancelled by their mirror row.
 * @param {string|import('mongoose').Types.ObjectId} employeeId
 * @returns {Promise<number|null>} The recomputed wallet balance, or null if none.
 * @sideeffect Writes `balance`/`lastEntryAt` on the wallet and `balanceAfter` on the entries.
 */
async function recomputeWalletBalance(employeeId) {
  const wallet = await getOrCreateWallet(employeeId);
  if (!wallet) return null;

  const entries = await KhataEntry.find({ employee: wallet.employee, status: 'Approved' })
    .sort({ date: 1, createdAt: 1 })
    .select('direction amount balanceAfter date');

  const { closing, running } = replayBalance(wallet.openingBalance, entries);

  // Only write rows whose stamped running balance actually moved.
  const writes = [];
  entries.forEach((entry, i) => {
    if (entry.balanceAfter !== running[i]) {
      writes.push({ updateOne: { filter: { _id: entry._id }, update: { $set: { balanceAfter: running[i] } } } });
    }
  });
  if (writes.length) await KhataEntry.bulkWrite(writes, { ordered: false });

  wallet.balance = closing;
  wallet.lastEntryAt = entries.length ? entries[entries.length - 1].date : null;
  await wallet.save();
  return wallet.balance;
}

/**
 * Replay one expense book's total from the spending filed under it.
 *
 * `spent` is a TOTAL, not a balance, so it is summed rather than run: what did
 * this book cost. A reversal filed under the book nets back off it, which is why
 * the sum is signed rather than a plain addition of amounts.
 *
 * ONLY SPENDING COUNTS. The query filters on type rather than taking everything
 * in the book, because a book can still contain rows that do not belong to it:
 * a database migrated from the per-khata era has advances and settlements filed
 * under one (scripts/migrateKhataWallet.js detaches them, but the module has to
 * read correctly before anybody runs it), and an advance counted here would come
 * out NEGATIVE under the sign flip below and print as "-₹4,500 spent", which is
 * not a thing that can happen to a cost.
 * @param {string|import('mongoose').Types.ObjectId} khataId
 * @returns {Promise<number|null>} The recomputed total, or null if no such book.
 * @sideeffect Writes `spent`/`entryCount`/`lastEntryAt` on the khata.
 */
async function recomputeKhataSpent(khataId) {
  if (!khataId) return null;
  const khata = await EmployeeKhata.findById(khataId);
  if (!khata) return null;

  const entries = await KhataEntry.find({
    khata: khata._id,
    status: 'Approved',
    // Spending, plus the reversals that cancel it — a reversal is filed under
    // whatever it reverses, so one against an expense has to come back off the
    // book it was charged to.
    type: { $in: [...KHATA_TYPES, 'reversal'] },
  })
    .sort({ date: 1, createdAt: 1 })
    .select('direction amount date');

  // Spending is 'from_employee', so it is NEGATIVE under the wallet sign rule.
  // Flip it: a book's total reads as a positive cost, which is the only way
  // anybody ever talks about what a site or a vehicle has run to.
  const spent = round2(entries.reduce((sum, e) => sum - signedAmount(e), 0));

  khata.spent = spent;
  khata.entryCount = entries.length;
  khata.lastEntryAt = entries.length ? entries[entries.length - 1].date : null;
  await khata.save();
  return spent;
}

/**
 * Recompute everything one entry touches: the employee's wallet always, and the
 * expense book it was filed under when it had one.
 *
 * Every posting path ends here rather than calling the two by hand, so a new
 * one cannot update the pot and forget the book (or the reverse) and leave the
 * two disagreeing.
 * @param {{employee: any, khata: any}} entry - A saved KhataEntry.
 * @returns {Promise<number|null>} The recomputed wallet balance.
 */
async function recomputeFor(entry) {
  if (entry.khata) await recomputeKhataSpent(entry.khata);
  return recomputeWalletBalance(entry.employee);
}

/**
 * Recompute a cash account's balance from its own ledger.
 *
 * Delegates to the cashbook's own implementation so there is one definition of
 * a cash-account balance, not two that can disagree. Required lazily: the
 * cashbook controller is a heavy module and this avoids a load-order cycle once
 * the cashbook starts referencing the khata in Phase 5.
 * @param {string|import('mongoose').Types.ObjectId} accountId
 * @returns {Promise<number|null>}
 */
async function recomputeCashAccount(accountId) {
  if (!accountId) return null;
  const { recomputeBalance } = require('../controllers/cashbookController');
  return recomputeBalance(accountId);
}

// ---------------------------------------------------------------------------
// Authorization — who may pay whom, out of which account, up to how much
// ---------------------------------------------------------------------------

/**
 * What a user is allowed to do with one specific cash account's khata payouts.
 *
 * Holding `khata.manage` opens the module; it does not by itself let anyone
 * move money. Paying out of a particular book additionally requires being
 * listed in that account's `operators`. A SuperAdmin is treated as an operator
 * on every account with no threshold — which is what makes a newly created
 * account usable before anyone has been added to it.
 * @param {object} user - The acting user (needs role, _id).
 * @param {object} account - A CashAccount document.
 * @returns {{allowed: boolean, canDisburse: boolean, canApprove: boolean, threshold: number, reason?: string}}
 */
function resolveDisburseRights(user, account) {
  const denied = (reason) => ({ allowed: false, canDisburse: false, canApprove: false, threshold: 0, reason });
  if (!user || !account) return denied('Unknown user or account');
  if (!account.isActive) return denied(`"${account.name}" is archived and cannot be used`);

  if (user.role === 'SuperAdmin') {
    return { allowed: true, canDisburse: true, canApprove: true, threshold: 0 };
  }

  const op = (account.operators || []).find((o) => String(o.user) === String(user._id));
  if (!op) {
    return denied(`You are not an authorized operator on "${account.name}". Ask a Super Admin to add you.`);
  }
  return {
    allowed: true,
    canDisburse: op.canDisburse !== false,
    canApprove: op.canApprove === true,
    threshold: Number(op.maxPerTransaction) || 0,
  };
}

/**
 * Whether a payout of this size posts immediately or parks for approval.
 *
 * A threshold of 0 means "no threshold" — always direct. An operator with
 * `canDisburse: false` records entries but never releases cash, so everything
 * they raise parks regardless of amount.
 * @param {{canDisburse: boolean, threshold: number}} rights - From resolveDisburseRights.
 * @param {number} amount
 * @returns {boolean} True to post straight away; false to leave it Pending.
 */
function willAutoApprove(rights, amount) {
  if (!rights.allowed || !rights.canDisburse) return false;
  if (!rights.threshold) return true;
  return round2(amount) <= round2(rights.threshold);
}

/**
 * The cash accounts a user may pay employees from, with their limits attached.
 *
 * Backs the account picker on every give-advance form, so the form can only
 * ever offer accounts the request will actually be allowed to use.
 * @param {object} user - The acting user.
 * @returns {Promise<Array<{_id: any, name: string, type: string, currentBalance: number, canDisburse: boolean, canApprove: boolean, threshold: number}>>}
 */
async function listOperableAccounts(user) {
  const query = { isActive: true };
  // Everyone but a SuperAdmin sees only the accounts they are listed on, so the
  // filter happens in the database rather than after loading every account.
  if (user.role !== 'SuperAdmin') query['operators.user'] = user._id;

  const accounts = await CashAccount.find(query).sort({ name: 1 });
  return accounts.map((acc) => {
    const rights = resolveDisburseRights(user, acc);
    return {
      _id: acc._id,
      name: acc.name,
      type: acc.type,
      currency: acc.currency,
      currentBalance: acc.currentBalance,
      canDisburse: rights.canDisburse,
      canApprove: rights.canApprove,
      threshold: rights.threshold,
    };
  });
}

/**
 * Refuse an advance that would push the employee past their wallet limit.
 *
 * Only outbound money is checked, and only against a limit that has been set
 * (0 = no limit). Settlements and expenses always go through — nobody should
 * ever be blocked from accounting for money they already hold.
 *
 * The limit is per PERSON, on the wallet, because the pot is the person's. It
 * used to sit on each khata, which meant somebody could quietly hold more than
 * anybody intended simply by opening a second book.
 * @param {object} wallet - The EmployeeWallet document.
 * @param {{direction: string, amount: number}} entry
 * @throws {Error} With `.statusCode = 400` when the limit would be breached.
 */
function assertWithinCreditLimit(wallet, entry) {
  if (entry.direction !== 'to_employee') return;
  const limit = Number(wallet?.creditLimit) || 0;
  if (!limit) return;
  const projected = round2((wallet.balance || 0) + entry.amount);
  if (projected > limit) {
    const err = new Error(
      `This would take the employee to ₹${projected.toLocaleString('en-IN')} in hand, over their ₹${limit.toLocaleString('en-IN')} advance limit. `
      + 'Collect a settlement first, or ask a Super Admin to raise the limit.'
    );
    err.statusCode = 400;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The company-cash leg
// ---------------------------------------------------------------------------

/**
 * Post (or reverse) the cashbook side of a khata entry and cross-link the two.
 *
 * Money leaving the company towards an employee is an 'out' on the chosen
 * account; money coming back is an 'in'. The khata entry's own reference code
 * is written into the cashbook row so either book can be traced from the other
 * by eye, without an id lookup.
 * @param {object} entry - A saved KhataEntry document.
 * @param {object} actor - The acting user.
 * @param {object|null} [employee] - Populated employee, for the payee name.
 * @returns {Promise<object|null>} The created CashbookEntry, or null if this entry moves no company cash.
 * @sideeffect Writes `cashbookEntry` on the khata entry and recomputes the account balance.
 */
async function postCashLeg(entry, actor, employee) {
  if (!entry.affectsCompanyCash || !entry.cashAccount) return null;
  // Already posted — an approval replayed, or a retried request. Never pay twice.
  if (entry.cashbookEntry) return CashbookEntry.findById(entry.cashbookEntry);

  const who = nameOf(employee);
  const cashEntry = await CashbookEntry.create({
    account: entry.cashAccount,
    type: entry.direction === 'to_employee' ? 'out' : 'in',
    amount: entry.amount,
    date: entry.date,
    category: CASH_CATEGORY[entry.type] || (entry.direction === 'to_employee' ? CASH_CATEGORY.advance : CASH_CATEGORY.settlement),
    paymentMode: entry.paymentMode === 'Adjustment' ? 'Other' : entry.paymentMode,
    description: entry.purpose || `Employee khata — ${entry.type}`,
    party: who,
    referenceNo: entry.code || undefined,
    status: 'Approved',
    employee: entry.employee,
    sourceKhataEntry: entry._id,
    createdBy: actor?._id,
  });

  entry.cashbookEntry = cashEntry._id;
  await entry.save();

  const balance = await recomputeCashAccount(entry.cashAccount);
  cashEntry.balanceAfter = balance;
  await cashEntry.save();
  return cashEntry;
}

// ---------------------------------------------------------------------------
// Posting, approving, rejecting, reversing
// ---------------------------------------------------------------------------

/**
 * Create a khata entry and, when it posts immediately, move the company cash too.
 *
 * This is the single entry point for every new line — an advance from the admin
 * screen, an employee's declared return, and (from Phase 5) the rows the loan
 * and expense modules post automatically.
 *
 * @param {object} input
 * @param {string|object} input.employee - Whose wallet this moves.
 * @param {'to_employee'|'from_employee'} input.direction - Which way the money went.
 * @param {number} input.amount - Positive amount; the sign comes from `direction`.
 * @param {string} [input.type='other'] - Reporting label (see KhataEntry.ENTRY_TYPES).
 * @param {string} [input.khata] - The expense book, for an 'expense'; ignored otherwise.
 * @param {Date} [input.date]
 * @param {string} [input.purpose]
 * @param {string} [input.category]
 * @param {string} [input.paymentMode]
 * @param {string} [input.referenceNo]
 * @param {string} [input.cashAccount] - Required when the entry moves company cash.
 * @param {boolean} [input.affectsCompanyCash=true]
 * @param {boolean} [input.autoApprove=false] - Post now, or leave for a reviewer.
 * @param {string} [input.status] - Park in a specific waiting state ('AwaitingApproval'); ignored when autoApprove.
 * @param {boolean} [input.raisedByEmployee=false]
 * @param {string} [input.idempotencyKey] - Replays return the original row instead of paying twice.
 * @param {object} [input.source] - {sourceLoan, sourceExpense, sourcePayroll} back-references.
 * @param {object} actor - The acting user.
 * @returns {Promise<{entry: object, wallet: object, khata: object|null, cashEntry: object|null, duplicate: boolean}>}
 * @throws {Error} `.statusCode = 400` on a credit-limit breach or a missing account.
 */
async function postEntry(input, actor) {
  const amount = round2(input.amount);
  if (!(amount > 0)) {
    const err = new Error('Amount must be greater than zero');
    err.statusCode = 400;
    throw err;
  }

  // A replayed request — a double tap, or a mobile retry over a flaky link —
  // must return the row it already created, not create a second one.
  if (input.idempotencyKey) {
    const prior = await KhataEntry.findOne({ idempotencyKey: input.idempotencyKey });
    if (prior) {
      return {
        entry: prior,
        wallet: await getOrCreateWallet(prior.employee),
        khata: prior.khata ? await EmployeeKhata.findById(prior.khata) : null,
        cashEntry: null,
        duplicate: true,
      };
    }
  }

  const employeeId = input.employee?._id || input.employee;
  const type = input.type || 'other';

  // Spending is filed under an expense book; everything else moves the wallet
  // on its own and carries no khata at all. resolveKhata validates ownership
  // and that the book is still open, and falls back to their default when none
  // is named — so filing an expense never fails for want of setup.
  const khata = needsKhata(type) ? await resolveKhata(employeeId, input.khata, actor) : null;

  // The pot every row moves, opened on first use.
  const wallet = await getOrCreateWallet(employeeId, actor);

  const affectsCompanyCash = input.affectsCompanyCash !== false;
  const autoApprove = input.autoApprove === true;

  // An entry that moves company cash needs to know which book it moved through
  // before it can post. While it is still Pending the account may be blank —
  // that is exactly the decision the approver is being asked to make.
  if (autoApprove && affectsCompanyCash && !input.cashAccount) {
    const err = new Error('Choose which company account this money moves through.');
    err.statusCode = 400;
    throw err;
  }

  const draft = { direction: input.direction, amount };
  // Only enforce the limit for money actually going out now. A parked request
  // is re-checked at approval time, when the balance may well have changed.
  if (autoApprove) assertWithinCreditLimit(wallet, draft);

  // Where an unposted row waits. Callers pass 'AwaitingApproval' for an advance
  // request that still needs an executive's sanction; everything else parks
  // with the cash operators.
  const parkedStatus = input.status === 'AwaitingApproval' ? 'AwaitingApproval' : 'Pending';

  const entry = await KhataEntry.create({
    employee: employeeId,
    khata: khata ? khata._id : null,
    direction: input.direction,
    type,
    amount,
    date: input.date || new Date(),
    purpose: input.purpose,
    category: input.category || 'Uncategorized',
    paymentMode: input.paymentMode || 'Cash',
    referenceNo: input.referenceNo,
    // Where the employee was when they filed this, when a client sent it. The
    // document is built from an explicit allowlist, so a new field has to be
    // named here or it is silently dropped on the way through.
    filedLocation: input.filedLocation || null,
    affectsCompanyCash,
    cashAccount: input.cashAccount || undefined,
    status: autoApprove ? 'Approved' : parkedStatus,
    execApprovalRequired: input.execApprovalRequired === true,
    raisedByEmployee: input.raisedByEmployee === true,
    createdBy: actor?._id,
    reviewedBy: autoApprove ? actor?._id : undefined,
    reviewedAt: autoApprove ? new Date() : undefined,
    idempotencyKey: input.idempotencyKey || undefined,
    sourceLoan: input.source?.sourceLoan || null,
    sourceExpense: input.source?.sourceExpense || null,
    sourcePayroll: input.source?.sourcePayroll || null,
  });

  let cashEntry = null;
  if (autoApprove) {
    const employee = await User.findById(employeeId).select('firstName lastName');
    cashEntry = await postCashLeg(entry, actor, employee);
    await recomputeFor(entry);
  }

  return {
    entry,
    wallet: await getOrCreateWallet(employeeId),
    khata: khata ? await EmployeeKhata.findById(khata._id) : null,
    cashEntry,
    duplicate: false,
  };
}

/**
 * Sanction (or decline) an advance request that was waiting on an executive.
 *
 * This is the FIRST of the two decisions an advance passes through, and the
 * only one about whether the person should have the money at all. It moves no
 * cash and touches no balance: approving simply hands the request on to the
 * people who keep the accounts, who then choose which one to pay it from.
 * @param {object} entry - An 'AwaitingApproval' KhataEntry document.
 * @param {object} actor - The CEO/MD/SuperAdmin deciding.
 * @param {boolean} approve - True to sanction, false to decline.
 * @param {string} [note] - Their reason; shown to the employee either way.
 * @returns {Promise<object>} The updated entry.
 * @throws {Error} `.statusCode = 400` if it is not waiting on an executive.
 */
async function decideExecApproval(entry, actor, approve, note) {
  if (entry.status !== 'AwaitingApproval') {
    const err = new Error(`This request is already ${entry.status === 'Pending' ? 'approved and with the accounts team' : entry.status.toLowerCase()}.`);
    err.statusCode = 400;
    throw err;
  }

  entry.execApprovedBy = actor?._id;
  entry.execApprovedAt = new Date();
  if (note) entry.execNote = String(note).slice(0, 500);
  // Sanctioned money still has to come OUT of somewhere, so an approval hands
  // the request on to the operators rather than paying it.
  entry.status = approve ? 'Pending' : 'Rejected';
  if (!approve) {
    entry.reviewedBy = actor?._id;
    entry.reviewedAt = new Date();
    entry.reviewNote = note;
  }
  await entry.save();
  return entry;
}

/**
 * Approve a Pending entry: the money moves now.
 *
 * The credit limit is re-checked here rather than trusted from submission time,
 * because a request can sit in the queue while other entries change the balance
 * underneath it.
 * @param {object} entry - A Pending KhataEntry document.
 * @param {object} actor - The approving user.
 * @param {object} [opts]
 * @param {string} [opts.cashAccount] - Which book to pay from, if not already set.
 * @param {string} [opts.note] - Review note stored on the entry.
 * @returns {Promise<{entry: object, khata: object, cashEntry: object|null}>}
 * @throws {Error} `.statusCode = 400` if not Pending, no account chosen, or over the limit.
 */
async function approveEntry(entry, actor, opts = {}) {
  if (entry.status === 'AwaitingApproval') {
    const err = new Error('This advance still needs a CEO/MD sanction before it can be paid.');
    err.statusCode = 400;
    throw err;
  }
  if (entry.status !== 'Pending') {
    const err = new Error(`This entry is already ${entry.status.toLowerCase()} and cannot be approved again.`);
    err.statusCode = 400;
    throw err;
  }
  if (opts.cashAccount) entry.cashAccount = opts.cashAccount;
  if (entry.affectsCompanyCash && !entry.cashAccount) {
    const err = new Error('Choose which company account this money moves through.');
    err.statusCode = 400;
    throw err;
  }

  assertWithinCreditLimit(await getOrCreateWallet(entry.employee), entry);

  entry.status = 'Approved';
  entry.reviewedBy = actor?._id;
  entry.reviewedAt = new Date();
  if (opts.note) entry.reviewNote = opts.note;
  await entry.save();

  const employee = await User.findById(entry.employee).select('firstName lastName');
  const cashEntry = await postCashLeg(entry, actor, employee);
  await recomputeFor(entry);

  return {
    entry,
    wallet: await getOrCreateWallet(entry.employee),
    khata: entry.khata ? await EmployeeKhata.findById(entry.khata) : null,
    cashEntry,
  };
}

/**
 * Decline a Pending entry. No money moves and the balance is untouched.
 * @param {object} entry - A Pending KhataEntry document.
 * @param {object} actor - The reviewing user.
 * @param {string} [note] - Why it was declined; shown to the employee.
 * @returns {Promise<object>} The updated entry.
 * @throws {Error} `.statusCode = 400` if the entry is not Pending.
 */
async function rejectEntry(entry, actor, note) {
  if (!['Pending', 'AwaitingApproval'].includes(entry.status)) {
    const err = new Error(`This entry is already ${entry.status.toLowerCase()} and cannot be rejected.`);
    err.statusCode = 400;
    throw err;
  }
  entry.status = 'Rejected';
  entry.reviewedBy = actor?._id;
  entry.reviewedAt = new Date();
  entry.reviewNote = note;
  await entry.save();
  return entry;
}

/**
 * Cancel a posted entry by writing its mirror image — never by deleting it.
 *
 * The original stays exactly as it was, marked 'Reversed', and a new row of the
 * opposite direction is written against it. The company cash leg is reversed
 * the same way, so both books end up square and both still show what happened.
 * This is what makes the ledger auditable: a correction reads as
 * "₹5,000 out, ₹5,000 back, ₹4,500 out", not as a row that silently changed.
 * @param {object} entry - An Approved KhataEntry document.
 * @param {object} actor - The user performing the correction.
 * @param {string} reason - Why; required, and stored on both rows.
 * @returns {Promise<{original: object, reversal: object, khata: object}>}
 * @throws {Error} `.statusCode = 400` if the entry is not Approved or already reversed.
 */
async function reverseEntry(entry, actor, reason) {
  if (entry.status !== 'Approved') {
    const err = new Error(`Only a posted entry can be reversed — this one is ${entry.status.toLowerCase()}.`);
    err.statusCode = 400;
    throw err;
  }
  if (entry.reversedBy) {
    const err = new Error('This entry has already been reversed.');
    err.statusCode = 400;
    throw err;
  }
  if (!reason || !String(reason).trim()) {
    const err = new Error('Give a reason for the reversal — it goes on the permanent record.');
    err.statusCode = 400;
    throw err;
  }

  const reversal = await KhataEntry.create({
    employee: entry.employee,
    // A reversal is filed under whatever the original was, so cancelling an
    // expense takes the cost back off the book it was charged to.
    khata: entry.khata || null,
    // The mirror image: money that went out now comes back, and vice versa.
    direction: entry.direction === 'to_employee' ? 'from_employee' : 'to_employee',
    type: 'reversal',
    amount: entry.amount,
    date: new Date(),
    purpose: `Reversal of ${entry.code || 'entry'} — ${reason}`,
    category: entry.category,
    paymentMode: entry.paymentMode,
    affectsCompanyCash: entry.affectsCompanyCash,
    cashAccount: entry.cashAccount,
    status: 'Approved',
    reversalOf: entry._id,
    reversalReason: reason,
    createdBy: actor?._id,
    reviewedBy: actor?._id,
    reviewedAt: new Date(),
  });

  entry.status = 'Reversed';
  entry.reversedBy = reversal._id;
  entry.reversalReason = reason;
  await entry.save();

  const employee = await User.findById(entry.employee).select('firstName lastName');
  await postCashLeg(reversal, actor, employee);

  // The original's cash leg stays on the cashbook as a historical fact; the
  // reversal's own leg is what squares the account. Both books now balance.
  await recomputeFor(entry);

  return {
    original: entry,
    reversal,
    wallet: await getOrCreateWallet(entry.employee),
    khata: entry.khata ? await EmployeeKhata.findById(entry.khata) : null,
  };
}

// ---------------------------------------------------------------------------
// Correcting an expense before the company has confirmed it
// ---------------------------------------------------------------------------

/**
 * Whether a posted expense can still be corrected in place, and by whom.
 *
 * WHY AN EDIT AT ALL, in a ledger where nothing is ever changed. An expense is
 * the one row that posts without anybody approving it (see recordMyExpense):
 * the purchase already happened, so holding the record only made the wallet lie
 * about what was left. That speed is worth having, but it means the figure
 * lands on the ledger before any second pair of eyes — and a digit fat-fingered
 * at a shop counter should be fixable by the person who typed it, not require a
 * reversal and a re-entry that reads like a fraud being unwound.
 *
 * So the window is exactly the gap the fast posting opened: from the moment it
 * is recorded to the moment the company confirms it. After confirmation it is a
 * settled record and the only correction left is a reversal.
 *
 * The BOOK BEING CLOSED ends the employee's half of that window but not the
 * company's. Closing is the company saying "this job is done and its figures
 * are ours now"; leaving the employee able to reach back into it would make the
 * closure meaningless, while the company still has to be able to fix what it
 * finds in there.
 * @param {object} entry - A KhataEntry document.
 * @param {object} [khata] - The book it is filed under, when loaded.
 * @returns {{employee: boolean, company: boolean, reason: string}} `reason`
 *   explains a `false`, in words the person who tried it can act on.
 */
function expenseEditability(entry, khata) {
  const no = (reason) => ({ employee: false, company: false, reason });

  if (!entry || entry.type !== 'expense') {
    return no('Only an expense can be edited. Anything else is corrected by reversing it.');
  }
  if (entry.status === 'Reversed' || entry.reversedBy) {
    return no('This expense has been reversed, so it can no longer be changed.');
  }
  if (entry.status !== 'Approved') {
    return no(`This entry is ${String(entry.status).toLowerCase()} and cannot be edited.`);
  }
  if (entry.confirmedByCompany) {
    return no('The company has confirmed this expense. Reverse it if it is wrong.');
  }

  const bookOpen = !khata || khata.isActive !== false;
  return {
    // Only the person who filed it — an expense the company recorded on their
    // behalf is the company's row to correct.
    employee: entry.raisedByEmployee === true && bookOpen,
    company: true,
    reason: bookOpen ? '' : `"${khata.name}" has been closed, so only the company can change entries in it.`,
  };
}

/** One field's before/after, phrased for the edit trail. */
const changeLine = (label, before, after) => `${label}: ${before ?? '—'} → ${after ?? '—'}`;

/**
 * Apply a correction to an unconfirmed expense and replay everything it moves.
 *
 * The row is changed in place — this is the one place in the module that does
 * that — but never silently: what it used to say is appended to `edits` before
 * the new values are written, so the trail survives even though the row does
 * not keep a second copy of itself.
 *
 * MOVING IT TO ANOTHER BOOK is a legitimate correction (filed under the wrong
 * site), and the reason both books are recomputed rather than one: the cost has
 * to come OFF the old heading as well as land on the new one.
 * @param {object} entry - An Approved, unconfirmed expense document.
 * @param {object} changes - Any of amount/purpose/category/paymentMode/referenceNo/date/khata.
 * @param {object} actor - Who is correcting it.
 * @param {{asEmployee?: boolean}} [opts] - Marks the trail entry as the employee's own.
 * @returns {Promise<{entry: object, wallet: object, khata: object|null}>}
 * @throws {Error} `.statusCode` set for a khata that is not theirs or is closed.
 */
async function applyExpenseEdit(entry, changes, actor, opts = {}) {
  const lines = [];
  const previousKhataId = entry.khata ? String(entry.khata) : null;

  if (changes.amount !== undefined) {
    const next = round2(changes.amount);
    if (!(next > 0)) {
      const err = new Error('Enter an amount greater than zero');
      err.statusCode = 400;
      throw err;
    }
    if (next !== round2(entry.amount)) {
      lines.push(changeLine('amount', `₹${round2(entry.amount)}`, `₹${next}`));
      entry.amount = next;
    }
  }

  if (changes.khata !== undefined && String(changes.khata) !== previousKhataId) {
    // resolveKhata refuses a book belonging to somebody else, and a closed one
    // — an expense cannot be moved INTO a book that has been shut, by either
    // side, or closing a book would not stop it growing.
    const target = await resolveKhata(entry.employee, changes.khata, actor);
    const before = previousKhataId ? await EmployeeKhata.findById(previousKhataId).select('name') : null;
    lines.push(changeLine('khata', before?.name, target.name));
    entry.khata = target._id;
  }

  const text = [
    ['purpose', 'what for'],
    ['category', 'category'],
    ['paymentMode', 'paid by'],
    ['referenceNo', 'reference'],
  ];
  for (const [field, label] of text) {
    if (changes[field] === undefined) continue;
    const next = String(changes[field] || '').trim();
    if (next !== String(entry[field] || '')) {
      lines.push(changeLine(label, entry[field], next));
      entry[field] = next;
    }
  }

  if (changes.date !== undefined && changes.date) {
    const next = new Date(changes.date);
    if (!Number.isNaN(next.getTime()) && next.getTime() !== new Date(entry.date).getTime()) {
      lines.push(changeLine('date', new Date(entry.date).toDateString(), next.toDateString()));
      entry.date = next;
    }
  }

  // A replaced bill is handled by the caller (it owns the file storage), but it
  // belongs in the same trail entry as the rest of the correction.
  if (changes.receiptReplaced) lines.push('bill replaced');

  if (lines.length) {
    entry.edits.push({
      at: new Date(),
      by: actor?._id,
      byEmployee: opts.asEmployee === true,
      summary: lines.join('; ').slice(0, 600),
    });
  }
  await entry.save();

  // Both books, because the cost may have moved between them, and the wallet,
  // because the amount may have changed. recomputeFor covers the new book and
  // the wallet; the old one has to be asked for by name.
  if (previousKhataId && previousKhataId !== String(entry.khata || '')) {
    await recomputeKhataSpent(previousKhataId);
  }
  await recomputeFor(entry);

  return {
    entry,
    wallet: await getOrCreateWallet(entry.employee),
    khata: entry.khata ? await EmployeeKhata.findById(entry.khata) : null,
    changed: lines.length > 0,
    summary: lines.join('; '),
  };
}

/**
 * Mark an expense as checked by the company, which closes it to further edits.
 *
 * Moves no money — the row already counted the moment it was recorded. What it
 * changes is who may still touch it: nobody, short of a reversal.
 * @param {object} entry - An Approved, unconfirmed expense document.
 * @param {object} actor - Whoever on the company side looked at it.
 * @param {string} [note] - Optional remark, shown to the employee.
 * @returns {Promise<object>} The saved entry.
 * @throws {Error} `.statusCode = 400` if it is not an expense awaiting confirmation.
 */
async function confirmExpense(entry, actor, note) {
  const rights = expenseEditability(entry);
  if (!rights.company) {
    const err = new Error(rights.reason || 'This expense cannot be confirmed.');
    err.statusCode = 400;
    throw err;
  }
  entry.confirmedByCompany = true;
  entry.confirmedBy = actor?._id;
  entry.confirmedAt = new Date();
  entry.reviewedBy = actor?._id;
  entry.reviewedAt = new Date();
  if (note) entry.reviewNote = String(note).slice(0, 500);
  await entry.save();
  return entry;
}

module.exports = {
  round2,
  splitTotals,
  signedAmount,
  needsKhata,
  nameOf,
  ensureKhataIntegrity,
  getOrCreateWallet,
  getOrCreateDefaultKhata,
  resolveKhata,
  listKhatasOf,
  replayBalance,
  recomputeWalletBalance,
  recomputeKhataSpent,
  recomputeFor,
  recomputeCashAccount,
  resolveDisburseRights,
  willAutoApprove,
  listOperableAccounts,
  assertWithinCreditLimit,
  postCashLeg,
  postEntry,
  decideExecApproval,
  approveEntry,
  rejectEntry,
  reverseEntry,
  expenseEditability,
  applyExpenseEdit,
  confirmExpense,
  CASH_CATEGORY,
};
