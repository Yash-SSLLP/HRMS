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

console.log('\n--- rounding ---');
check('classic float error is rounded away', L.round2(0.1 + 0.2), 0.3);
check('third decimal rounds up', L.round2(1234.567), 1234.57);
check('non-numeric input becomes zero rather than NaN', L.round2(undefined), 0);

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed.`);
if (failures.length) {
  failures.forEach((f) => console.error(`\n  * ${f}`));
  process.exit(1);
}
