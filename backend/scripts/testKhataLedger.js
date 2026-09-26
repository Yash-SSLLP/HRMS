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

// WHAT COUNTS. recomputeWalletBalance replays only the rows L.isPosted passes,
// so these replay exactly that selection. The cases are the live ledgers that
// exposed the double credit (2026-09-26).
console.log('\n--- reversals: both halves count, so the pair nets to nothing ---');
const posted = (rows) => L.replayBalance(0, rows.filter(L.isPosted)).closing;
const st = (status, row) => ({ ...row, status });
check('Approved and Reversed rows are posted money',
  [L.isPosted({ status: 'Approved' }), L.isPosted({ status: 'Reversed' })], [true, true]);
check('Rejected, Pending and AwaitingApproval rows are not',
  ['Rejected', 'Pending', 'AwaitingApproval'].map((status) => L.isPosted({ status })), [false, false, false]);
// A ₹1 expense, reversed. The old Approved-only rule kept the reversal and dropped
// the expense, and left the person "holding" ₹1 they were never given.
const oneRupee = [st('Reversed', from(1)), st('Approved', to(1))];
check('a reversed expense leaves the wallet where it started', posted(oneRupee), 0);
check('(the old Approved-only rule credited it twice)',
  L.replayBalance(0, oneRupee.filter((e) => e.status === 'Approved')).closing, 1);
// Two expenses reversed, two that stand: the company owes the two that stand.
check('reversed expenses drop out, the ones that stand remain owed', posted([
  st('Reversed', from(500)), st('Reversed', from(200)), st('Approved', to(200)), st('Approved', to(500)),
  st('Approved', from(500)), st('Approved', from(500)),
]), -1000);
// A reversal reversed, and so on: every row posted, the parity decides the net.
// Four reversals back to back reinstate the expense.
check('a chain of reversals nets by its parity (expense reinstated)', posted([
  st('Reversed', from(2000)), st('Reversed', to(2000)), st('Reversed', from(2000)), st('Reversed', to(2000)),
  st('Approved', from(2000)),
]), -2000);
check('two reversals reinstate it', posted([
  st('Reversed', from(2000)), st('Reversed', to(2000)), st('Approved', from(2000)),
]), -2000);
check('three cancel it again', posted([
  st('Reversed', from(2000)), st('Reversed', to(2000)), st('Reversed', from(2000)), st('Approved', to(2000)),
]), 0);
check('rejected and waiting rows still move nothing', posted([
  st('Rejected', to(9000)), st('Pending', to(700)), st('AwaitingApproval', to(300)), st('Approved', to(100)),
]), 100);

// "How this adds up": a reversal comes back off the line of whatever it
// reversed — never a line of its own. It used to land in "Advanced to you".
const { summariseEntries } = require('../controllers/khataController');
let rid = 0;
const row = (status, movement, entry, over = {}) => ({ _id: `r${rid += 1}`, status, movement, ...entry, ...over });
const sumOf = (rows) => { const s = summariseEntries(rows); return [s.advanced, s.spent, s.returned]; };
const e15 = row('Reversed', 'expense', from(500), { expenseBook: 'b1' });
const e16 = row('Reversed', 'expense', from(200), { expenseBook: 'b2' });
check('reversed expenses come off Spent, not onto Advanced', sumOf([
  e15, e16,
  row('Approved', 'reversal', to(200), { reversalOf: e16._id, expenseBook: 'b2' }),
  row('Approved', 'reversal', to(500), { reversalOf: e15._id, expenseBook: 'b1' }),
  row('Approved', 'expense', from(500), { expenseBook: 'b1' }),
  row('Approved', 'expense', from(500), { expenseBook: 'b3' }),
]), [0, 1000, 0]);
// The book the reversal was filed under can be gone (deleted); the chain still
// places it, because it follows reversalOf to the expense itself.
check('a reversal is placed by what it reversed even without its book', sumOf([
  e15, row('Approved', 'reversal', to(500), { reversalOf: e15._id, expenseBook: null }),
]), [0, 0, 0]);
const adv = row('Reversed', 'advance', to(5000));
check('a reversed advance comes off Advanced', sumOf([
  adv, row('Approved', 'reversal', from(5000), { reversalOf: adv._id }), row('Approved', 'advance', to(3000)),
]), [3000, 0, 0]);
const settle = row('Reversed', 'settlement', from(800));
check('a reversed return comes off Returned', sumOf([
  row('Approved', 'advance', to(1000)), settle, row('Approved', 'reversal', to(800), { reversalOf: settle._id }),
]), [1000, 0, 0]);
const c1 = row('Reversed', 'expense', from(2000), { expenseBook: 'b9' });
const c2 = row('Reversed', 'reversal', to(2000), { reversalOf: c1._id, expenseBook: 'b9' });
const c3 = row('Reversed', 'reversal', from(2000), { reversalOf: c2._id, expenseBook: 'b9' });
const c4 = row('Reversed', 'reversal', to(2000), { reversalOf: c3._id, expenseBook: 'b9' });
check('a chain stays on the line it started on', sumOf([
  c1, c2, c3, c4, row('Approved', 'reversal', from(2000), { reversalOf: c4._id, expenseBook: 'b9' }),
]), [0, 2000, 0]);
check('the lines always add up to the replayed wallet', (() => {
  const rows = [e15, e16, row('Approved', 'reversal', to(200), { reversalOf: e16._id, expenseBook: 'b2' }),
    row('Approved', 'advance', to(700)), row('Approved', 'expense', from(900), { expenseBook: 'b1' })];
  const [a, s, r] = sumOf(rows);
  return L.round2(a - s - r) === posted(rows);
})(), true);

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

// A reversed row counts BESIDE the reversal that cancels it (which carries the
// same category), so the pair nets to nothing under that heading. The old rule
// skipped the Reversed row and kept the reversal, printing every cancelled
// expense as money coming back.
const reversed = S.summariseByCategory([
  cat('Food', from(1000)),
  { ...cat('Food', from(500)), status: 'Reversed' },
  cat('Food', to(500)), // the reversal: same heading, the other way, Approved
]);
check('a reversed expense and its reversal net to nothing', reversed.rows[0].balance, -1000);
check('both halves stay on the record', [reversed.rows[0].out, reversed.rows[0].in], [1500, 500]);
check('and both are counted as entries', reversed.counted, 3);

// A statement is money that MOVED. A declined advance was never paid, and one
// still queued has not been paid yet — printing either as Cash In inflated the
// document and made its Final Balance disagree with the app. The employee still
// SEES a declined request in their cashbook, with the reason; it just is not
// money, so it is not on the statement.
const notMoney = S.summariseByCategory([
  { ...cat('Travel', to(1000)), status: 'Approved' },
  { ...cat('Travel', to(9000)), status: 'Rejected' },
  { ...cat('Travel', to(7000)), status: 'AwaitingApproval' },
  { ...cat('Travel', to(3000)), status: 'Pending' },
]);
check('a declined advance is not on the statement', notMoney.rows[0].in, 1000);
check('nor a request still awaiting sanction, nor one awaiting payment', notMoney.totals.in, 1000);
check('and none of them is counted as an entry', notMoney.counted, 1);

// The summary has to land on the same figure the ledger replay does, or a
// printed statement would contradict the balance on screen.
const walletRows = [{ ...to(25000), status: 'Approved' }, { ...from(5424), status: 'Approved' }];
check('the summary agrees with replayBalance',
  S.summariseByCategory(walletRows).totals.balance,
  L.replayBalance(0, walletRows).closing);
check('each category line says how many rows it holds', catRow('Travel').count, 3);

console.log('\n--- report layouts (services/cashbookEntriesPdf.js) ---');
// Every report type ends with the full entries list (2026-09-26), and the day
// tables carry what each day went on. Both are decided by pure code here, so
// they are pinned without drawing a page.
const P = require('../services/cashbookEntriesPdf');
check('four report types, one of them the new day-wise with categories',
  P.REPORT_KINDS, ['entries', 'daywise', 'daywise_category', 'category']);
// The controller validates ?report= against its own copy of the list (it must
// not load pdfkit on every filtered read), so the two are checked against each
// other here rather than trusted to stay in step.
const ctrlSource = require('fs').readFileSync(require.resolve('../controllers/khataController'), 'utf8');
const ctrlKinds = (ctrlSource.match(/const REPORT_KINDS = \[([^\]]*)\]/) || [])[1] || '';
check('the controller accepts exactly the renderer\'s report types',
  ctrlKinds.split(',').map((k) => k.trim().replace(/'/g, '')).filter(Boolean), P.REPORT_KINDS);

// Two days in IST. 23:30 on the 14th in India is 18:00 UTC — it must land on the
// 14th, not be pushed to the 15th or pulled back by a UTC server clock.
const at = (iso) => new Date(iso);
const dayRows = [
  { ...cat('Food', from(200)), date: at('2026-09-14T03:30:00Z') },
  { ...cat('Travel', from(500)), date: at('2026-09-14T06:00:00Z') },
  { ...cat('Food', from(100)), date: at('2026-09-14T18:00:00Z') },
  { ...cat('Hotel', from(900)), status: 'Rejected', date: at('2026-09-15T04:00:00Z') },
  { ...cat('Food', from(50)), date: at('2026-09-15T05:00:00Z') },
];
const days = P.groupByDay(dayRows, 1000);
check('rows fold into IST calendar days', days.map((d) => d.key), ['2026-09-14', '2026-09-15']);
check('a day lists what it went on, in first-seen order',
  days[0].categories.map((c) => [c.category, c.count, c.out]), [['Food', 2, 300], ['Travel', 1, 500]]);
check('the category lines under a day add up to the day',
  days.map((d) => d.categories.reduce((n, c) => n + c.count, 0)), days.map((d) => d.count));
check('a rejected row is listed under its category but moves no money',
  days[1].categories.map((c) => [c.category, c.count, c.out]), [['Hotel', 1, 0], ['Food', 1, 50]]);
check('each day closes on the running balance', days.map((d) => d.closing), [200, 150]);


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

// The Category dropdown on an expense. Not money arithmetic, but it decides
// whether somebody can record money they have already spent, so it is pinned
// here with the rest of the rules an expense has to pass.
console.log('\n--- Cash Out categories (services/cashOutCategories.js) ---');
const C = require('../services/cashOutCategories');

check('a saved list is tidied: trimmed, blanks and repeats gone, first spelling kept',
  C.cleanCategoryList(['  Fuel ', 'fuel', '', 'Site   materials', null, 'Travel', 'FUEL']),
  ['Fuel', 'Site materials', 'Travel']);
check('its order is kept exactly — that order IS the priority',
  C.cleanCategoryList(['Travel', 'Fuel', 'Food']), ['Travel', 'Fuel', 'Food']);
check('an empty list is a legitimate save', C.cleanCategoryList([]), []);
check('something that is not a list is refused', outcome(() => C.cleanCategoryList('Fuel')), 'blocked');
check('an over-long category is refused',
  outcome(() => C.cleanCategoryList(['x'.repeat(C.MAX_CATEGORY_LENGTH + 1)])), 'blocked');
check('the most the dropdown takes is allowed',
  outcome(() => C.cleanCategoryList(Array.from({ length: C.MAX_CATEGORIES }, (_, i) => `C${i}`))), 'allowed');
check('one more is refused',
  outcome(() => C.cleanCategoryList(Array.from({ length: C.MAX_CATEGORIES + 1 }, (_, i) => `C${i}`))), 'blocked');

const LIST = ['Fuel', 'Site materials', 'Travel'];
const fileAs = (list, value) => {
  try { return C.resolveExpenseCategory(list, value); } catch (_) { return 'blocked'; }
};
const correctTo = (list, value, current) => {
  try { return C.resolveExpenseCategory(list, value, { current }); } catch (_) { return 'blocked'; }
};
// No list set up: exactly the behaviour before the dropdown existed.
check('no list: an expense with no category files as Expense', fileAs([], undefined), 'Expense');
check('no list: whatever was sent is kept', fileAs([], 'Food'), 'Food');
// A list in force: a new expense must name one of its entries.
check('with a list, a category is required', fileAs(LIST, ''), 'blocked');
check('with a list, an off-list category is refused', fileAs(LIST, 'Materials'), 'blocked');
check('and a listed one is stored in the list\'s own spelling', fileAs(LIST, '  site MATERIALS '), 'Site materials');
// A correction is only held to the list when it CHANGES the category.
check('a correction that leaves a retired category alone is not forced off it',
  correctTo(LIST, 'Expense', 'Expense'), undefined);
check('nor is a change of case alone a change', correctTo(LIST, 'fuel', 'Fuel'), undefined);
check('a blank category on a correction means "leave it"', correctTo(LIST, '', 'Expense'), undefined);
check('moving it to a listed category is allowed', correctTo(LIST, 'travel', 'Expense'), 'Travel');
check('moving it off the list is refused', correctTo(LIST, 'Snacks', 'Expense'), 'blocked');

// Who writes the list: Admin, CEO, MD and whoever manages the cashbook.
const may = (user) => C.canManageCashOutCategories(user);
check('the Backend, the CEO and the MD may — the executives even in read-only mode',
  [may({ role: 'SuperAdmin' }), may({ role: 'CEO' }), may({ role: 'MD', execEditAccess: false })], [true, true, true]);
check('so may the Accounts Manager role', may({ role: 'AccountsManager' }), true);
check('and anybody holding either cash module\'s switch',
  [may({ role: 'Employee', khataAccess: true }), may({ role: 'Manager', permissions: [], cashbookAccess: true })],
  [true, true]);
check('and an HR Manager or Manager explicitly ticked for one',
  [may({ role: 'HRManager', permissions: ['khata.manage'] }), may({ role: 'Manager', permissions: ['cashbook.manage'] })],
  [true, true]);
// The trap this rule is written around: hasPermission reads an unconfigured HR
// Manager as holding every capability, and HR is not on the list.
check('an HR Manager with no permissions list is NOT swept in', may({ role: 'HRManager' }), false);
check('nor an ordinary employee, a bare Manager or the audit login',
  [may({ role: 'Employee' }), may({ role: 'Manager', permissions: [] }), may({ role: 'God' })], [false, false, false]);

console.log('\n--- rounding ---');
check('classic float error is rounded away', L.round2(0.1 + 0.2), 0.3);
check('third decimal rounds up', L.round2(1234.567), 1234.57);
check('non-numeric input becomes zero rather than NaN', L.round2(undefined), 0);

/**
 * The bills IN the report (2026-09-26): every bill attached in full at the end,
 * one page per picture and per page of a PDF bill, each row jumping to its bill
 * and each bill jumping back — links inside the file, because a web link is a
 * dead end in a phone's PDF viewer. Async (pdf-lib reads PDFs asynchronously),
 * so it runs before the summary below. The HEIC conversion is not pinned here:
 * it needs a real iPhone photo as a fixture; it was checked by hand on the nine
 * on file.
 */
async function billAttachmentChecks() {
  console.log('\n--- bills attached to a report (services/billAttachments.js) ---');
  const B = require('../services/billAttachments');
  const { PDFDocument, PDFName, PDFArray, PDFDict } = require('pdf-lib');

  const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // `blank` pages carry no content stream at all — which pdf-lib cannot embed,
  // and which once crashed the whole report at save().
  const pdfOf = async (pages, { blank = false } = {}) => {
    const d = await PDFDocument.create();
    for (let i = 0; i < pages; i += 1) {
      const pg = d.addPage(i % 2 ? [300, 200] : [200, 300]);
      if (!blank) pg.drawRectangle({ x: 20, y: 20, width: 100, height: 60 });
    }
    return Buffer.from(await d.save());
  };
  const twoPages = await pdfOf(2);
  const heicHead = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(12)]);
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1')]);
  // Passes the sniff, fails to decode — a phone upload that says it is a JPEG.
  const brokenJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);

  check('each kind of bill is told from its bytes, not its label',
    [PNG_1PX, twoPages, heicHead, webp, brokenJpeg, Buffer.from('hello world, not a bill')].map(B.sniff),
    ['png', 'pdf', 'heic', 'webp', 'jpeg', null]);

  const shrunk = B.downscale({ width: 40, height: 30, data: Buffer.alloc(40 * 30 * 4, 200) }, 20);
  check('a photo is shrunk to the long edge, keeping its shape and its colour',
    [shrunk.width, shrunk.height, shrunk.data[0], shrunk.data[3]], [20, 15, 200, 255]);

  const prepared = await Promise.all([PNG_1PX, twoPages, await pdfOf(12), webp].map(B.prepareBill));
  check('a picture passes through; a PDF is counted; a long one is capped; a WebP cannot go in',
    prepared.map((p) => [p.kind, p.pages || null, p.totalPages || null]),
    [['image', null, null], ['pdf', 2, 2], ['pdf', B.MAX_PDF_PAGES, 12], ['none', null, null]]);

  const P = require('../services/cashbookEntriesPdf');
  const row = (id, hour) => ({
    _id: id, date: new Date(`2026-09-20T0${hour}:00:00Z`), direction: 'from_employee', amount: 100 * hour,
    status: 'Approved', movement: 'expense', purpose: `bill ${id}`, code: `KHT-${id}`, hasAttachment: true,
  });
  const input = {
    company: { name: 'Co' }, employee: { name: 'T' }, book: { name: 'B' }, range: {}, opening: 0, footer: {},
    entries: [row('a', 1), row('b', 2), row('c', 3), row('d', 4)],
    billLinks: new Map([['c', 'https://example.test/bill/c/sig']]),
  };
  // How every page's links point: [jumps inside the file as page numbers, web links].
  const linksOf = async (pdf) => {
    const doc = await PDFDocument.load(pdf);
    const refs = doc.getPages().map((pg) => pg.ref.toString());
    return doc.getPages().map((pg) => {
      const jumps = [];
      let web = 0;
      const annots = pg.node.Annots();
      for (let i = 0; annots && i < annots.size(); i += 1) {
        const a = annots.lookup(i, PDFDict);
        const dest = a.lookup(PDFName.of('Dest'));
        if (dest instanceof PDFArray) jumps.push(refs.indexOf(dest.get(0).toString()) + 1);
        else if (a.lookup(PDFName.of('A'))) web += 1;
      }
      return [jumps.sort(), web];
    });
  };

  const withBills = await P.renderReport({
    ...input,
    bills: new Map([['a', PNG_1PX], ['b', twoPages], ['c', brokenJpeg], ['d', await pdfOf(1, { blank: true })]]),
  });
  check('each bill gets its own pages after the report: the photo, both PDF pages, the blank PDF — not the broken one',
    (await PDFDocument.load(withBills)).getPageCount(), 1 + 1 + 2 + 1);
  check('rows jump to their bill (thumbnail and "See bill"), bills jump back, the broken one keeps its web link',
    await linksOf(withBills), [[[2, 2, 3, 3, 5, 5], 1], [[1], 0], [[1], 0], [[1], 0], [[1], 0]]);

  const withoutBills = await P.renderReport(input);
  check('bills not asked for: one page, no jumps, the web link where there is one',
    await linksOf(withoutBills), [[[], 1]]);
}

(async () => {
  await billAttachmentChecks();
  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) {
    failures.forEach((f) => console.error(`\n  * ${f}`));
    process.exit(1);
  }
})().catch((err) => {
  console.error('\n  * the bill checks crashed:', err);
  process.exit(1);
});
