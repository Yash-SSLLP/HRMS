/**
 * Self-check for the employee-khata money rules.
 *
 *   node scripts/testKhataLedger.js
 *
 * Needs no database and touches nothing — every rule exercised here is a pure
 * function in services/khataLedger.js. These are the rules that decide whether
 * real cash leaves a company account and how much an employee is said to owe,
 * so they are worth being able to re-verify in one second after any change.
 *
 * Exits non-zero on the first failure, so it can be wired into CI as-is.
 */
const L = require('../services/khataLedger');

let passed = 0;
const failures = [];

/**
 * Assert deep equality and record the outcome.
 * @param {string} label - What is being checked.
 * @param {*} got - Actual value.
 * @param {*} want - Expected value.
 */
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed += 1; } else { failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`); }
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

/** Run a throwing rule and report which way it went, rather than crashing. */
function outcome(fn) {
  try { fn(); return 'allowed'; } catch (_) { return 'blocked'; }
}

const to = (amount) => ({ direction: 'to_employee', amount });   // company → employee
const from = (amount) => ({ direction: 'from_employee', amount }); // employee → company

console.log('\n--- sign convention (positive = employee owes the company) ---');
check('money out to an employee raises what they owe', L.signedAmount(to(500)), 500);
check('money back from an employee lowers it', L.signedAmount(from(500)), -500);

console.log('\n--- ledger replay ---');
check('empty ledger keeps the opening balance', L.replayBalance(0, []).closing, 0);
check('opening balance alone', L.replayBalance(1000, []).closing, 1000);
// The worked example: opening 1000, two advances out, one settlement back.
check('1000 + 500 + 700 - 800 = 1400', L.replayBalance(1000, [to(500), to(700), from(800)]).closing, 1400);
check('running balance is stamped after every row',
  L.replayBalance(1000, [to(500), to(700), from(800)]).running, [1500, 2200, 1400]);
check('settling in full squares the khata', L.replayBalance(0, [to(5000), from(5000)]).closing, 0);
check('overpaying flips it to "you will give"', L.replayBalance(0, [to(5000), from(6000)]).closing, -1000);
check('an employee spending their own money is owed it', L.replayBalance(0, [from(750)]).closing, -750);
// A reversal is just the mirror row, so it must land back on the original figure.
check('advance then its reversal nets to zero', L.replayBalance(0, [to(5000), from(5000)]).closing, 0);
check('reverse and re-post at the corrected figure',
  L.replayBalance(0, [to(5000), from(5000), to(4500)]).closing, 4500);
// Money must survive arithmetic that ordinary floats get wrong.
check('paise do not drift over many rows',
  L.replayBalance(0, Array.from({ length: 30 }, () => to(0.1))).closing, 3);
check('mixed paise settle exactly', L.replayBalance(0, [to(1234.56), from(1234.56)]).closing, 0);

console.log('\n--- who may pay, out of which account ---');
const account = {
  _id: 'acct-petty',
  name: 'Petty Cash',
  isActive: true,
  operators: [
    { user: 'supervisor', canDisburse: true, maxPerTransaction: 5000, canApprove: false },
    { user: 'recorder', canDisburse: false, maxPerTransaction: 0, canApprove: false },
    { user: 'finance', canDisburse: true, maxPerTransaction: 0, canApprove: true },
  ],
};
const rightsOf = (user) => L.resolveDisburseRights(user, account);

const superAdmin = rightsOf({ role: 'SuperAdmin', _id: 'boss' });
check('a Super Admin operates every account, unlimited',
  [superAdmin.allowed, superAdmin.canDisburse, superAdmin.canApprove, superAdmin.threshold], [true, true, true, 0]);

const supervisor = rightsOf({ role: 'Employee', _id: 'supervisor' });
check('a listed operator gets exactly their configured limit',
  [supervisor.allowed, supervisor.canDisburse, supervisor.threshold], [true, true, 5000]);
check('being listed does not confer approving other people\'s entries', supervisor.canApprove, false);

// The point of the whole per-account design: the capability opens the module,
// the operator list decides whose money you can touch.
check('an HR Manager not on the account cannot pay from it',
  rightsOf({ role: 'HRManager', _id: 'hr' }).allowed, false);
check('an archived account refuses everyone below Super Admin',
  L.resolveDisburseRights({ role: 'Employee', _id: 'supervisor' }, { ...account, isActive: false }).allowed, false);

console.log('\n--- direct payout vs parked for approval ---');
check('below the threshold pays out at once', L.willAutoApprove(supervisor, 4999), true);
check('exactly at the threshold still pays out', L.willAutoApprove(supervisor, 5000), true);
check('a rupee over the threshold parks for approval', L.willAutoApprove(supervisor, 5001), false);
check('a zero threshold means no threshold', L.willAutoApprove(rightsOf({ role: 'Employee', _id: 'finance' }), 999999), true);
check('an operator who may not disburse always parks',
  L.willAutoApprove(rightsOf({ role: 'Employee', _id: 'recorder' }), 1), false);
check('someone not on the account never auto-approves',
  L.willAutoApprove(rightsOf({ role: 'HRManager', _id: 'hr' }), 1), false);

console.log('\n--- credit limit ---');
const limitCheck = (balance, creditLimit, entry) => outcome(() => L.assertWithinCreditLimit({ balance, creditLimit }, entry));
check('no limit configured lets anything through', limitCheck(99999, 0, to(5000)), 'allowed');
check('comfortably within the limit', limitCheck(2000, 10000, to(5000)), 'allowed');
check('landing exactly on the limit is allowed', limitCheck(5000, 10000, to(5000)), 'allowed');
check('one rupee over the limit is refused', limitCheck(5001, 10000, to(5000)), 'blocked');
// Nobody should ever be stopped from handing money BACK.
check('a settlement is never blocked by a limit', limitCheck(99999, 10, from(5000)), 'allowed');
check('a settlement is never blocked even at zero balance', limitCheck(0, 1, from(5000)), 'allowed');

console.log('\n--- statement arithmetic (services/cashbookSummaryPdf.js) ---');
// The statement is a category-wise summary, so these two functions are the ones
// that decide what a printed, signed-off document says. Checked here alongside
// the ledger they mirror.
const S = require('../services/cashbookSummaryPdf');

// A wallet grows when money arrives; an expense book grows when money is spent.
// Same row, opposite sign — which is the whole reason `scope` is carried.
check('an advance raises the wallet', S.movement(to(5000), 'wallet'), 5000);
check('spending lowers the wallet', S.movement(from(5000), 'wallet'), -5000);
check('spending raises what the book has cost', S.movement(from(5000), 'khata'), 5000);
check('a credit back lowers what the book has cost', S.movement(to(5000), 'khata'), -5000);

// Category totals: IN is money that reached the employee, OUT money that left
// them, Balance = In - Out, so a heading only ever spent against reads negative.
const cat = (c, entry) => ({ ...entry, category: c, status: 'Approved' });
const sum = S.summariseByCategory([
  cat('Travel', from(5155)),
  cat('Travel', from(1000)),
  cat('Food', from(994)),
  cat('Travel', to(2000)),
]);
const catRow = (name) => sum.rows.find((r) => r.category === name);
check('rows fold into one line per category', sum.rows.length, 2);
check('spending in a category adds up', catRow('Travel').out, 6155);
check('money coming back lands in Cash In', catRow('Travel').in, 2000);
check('balance is in minus out', catRow('Travel').balance, -4155);
check('every counted row is counted once', sum.counted, 4);
check('the totals row adds the categories up', sum.totals.out, 7149);
check('and its balance matches', sum.totals.balance, -5149);

// An uncategorised row must still appear — silently dropping it would make the
// printed total disagree with the ledger.
const blank = S.summariseByCategory([cat('', from(300)), { ...from(200), status: 'Approved' }]);
check('a blank category is gathered under one heading', blank.rows.length, 1);
check('and keeps its money', blank.rows[0].out, 500);
check('"No Category" is what it is called', blank.rows[0].category, 'No Category');

// A reversed row was cancelled by its mirror; counting either would double it.
const reversed = S.summariseByCategory([
  cat('Food', from(1000)),
  { ...cat('Food', from(500)), status: 'Reversed' },
]);
check('a reversed row counts for nothing', reversed.rows[0].out, 1000);
check('and is not counted as an entry', reversed.counted, 1);

// The summary has to land on the same figure the ledger replay does, or a
// printed statement would contradict the balance on screen.
const walletRows = [{ ...to(25000), status: 'Approved' }, { ...from(5424), status: 'Approved' }];
check('the summary agrees with replayBalance',
  S.summariseByCategory(walletRows).totals.balance,
  L.replayBalance(0, walletRows).closing);


// Who may still correct a posted expense, and when the window shuts. Pure, and
// worth pinning: it is the rule that decides whether an employee can rewrite a
// figure the company has already acted on.
console.log('\n--- the expense editing window ---');
// `movement` is the employee-ledger kind since the khata and cashbook ledgers
// merged; `type` on a stored row is now the company's in/out sense.
const expense = (over = {}) => ({
  movement: 'expense', status: 'Approved', raisedByEmployee: true, confirmedByCompany: false, reversedBy: null, ...over,
});
const openBook = { isActive: true, name: 'Site A' };
const shutBook = { isActive: false, name: 'Site A' };
const rights = (e, k) => { const r = L.expenseEditability(e, k); return [r.employee, r.company]; };

check('a fresh expense in an open book is both theirs and ours to fix',
  rights(expense(), openBook), [true, true]);
check('closing the book ends the employee\'s half only',
  rights(expense(), shutBook), [false, true]);
check('confirming ends it for everybody',
  rights(expense({ confirmedByCompany: true }), openBook), [false, false]);
check('an expense the company recorded is not the employee\'s to change',
  rights(expense({ raisedByEmployee: false }), openBook), [false, true]);
check('a reversed expense is closed to both',
  rights(expense({ status: 'Reversed', reversedBy: 'x' }), openBook), [false, false]);
check('a parked row is not an editable one',
  rights(expense({ status: 'Pending' }), openBook), [false, false]);
// Everything else is corrected by reversal — there is no in-place edit for money
// that moved through a company account.
check('an advance is never edited in place', rights(expense({ movement: 'advance' }), null), [false, false]);
check('nor is a settlement', rights(expense({ movement: 'settlement' }), null), [false, false]);
check('a missing book reads as open rather than blocking the fix',
  rights(expense(), undefined), [true, true]);

console.log('\n--- rounding ---');
check('classic float error is rounded away', L.round2(0.1 + 0.2), 0.3);
check('third decimal rounds up', L.round2(1234.567), 1234.57);
check('non-numeric input becomes zero rather than NaN', L.round2(undefined), 0);

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed.`);
if (failures.length) {
  failures.forEach((f) => console.error(`\n  * ${f}`));
  process.exit(1);
}
