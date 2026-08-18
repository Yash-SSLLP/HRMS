/**
 * End-to-end check of the employee-khata ledger against a real database.
 *
 *   KHATA_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_khata_test" node scripts/testKhataIntegration.js
 *
 * WHY THE SEPARATE ENV VAR. This project's ordinary MONGO_URI points at the
 * live Atlas cluster, and this script CREATES AND DELETES DATA. It therefore
 * refuses to run unless you name a throwaway database explicitly in
 * KHATA_TEST_MONGO_URI, and refuses again if that value happens to match
 * MONGO_URI. Point it at a local mongod or a scratch Atlas database.
 *
 * What it proves, which the pure self-check (testKhataLedger.js) cannot:
 *   - an advance moves the employee's balance AND the company cash account,
 *     in opposite directions, with both rows cross-linked;
 *   - a replayed request pays out once, not twice;
 *   - an amount over the operator's limit moves NO cash until it is approved;
 *   - a reversal squares both books while deleting nothing;
 *   - a back-dated entry re-stamps every later running balance.
 *
 * Everything it creates is namespaced and removed again in a final cleanup.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TEST_URI = process.env.KHATA_TEST_MONGO_URI;
if (!TEST_URI) {
  console.error('\nRefusing to run: set KHATA_TEST_MONGO_URI to a THROWAWAY database.\n'
    + 'This script writes and deletes data and must never touch the live cluster.\n');
  process.exit(2);
}
if (process.env.MONGO_URI && TEST_URI.trim() === process.env.MONGO_URI.trim()) {
  console.error('\nRefusing to run: KHATA_TEST_MONGO_URI is the same as MONGO_URI (the live database).\n');
  process.exit(2);
}

const User = require('../models/User');
const CashAccount = require('../models/CashAccount');
const CashbookEntry = require('../models/CashbookEntry');
const EmployeeKhata = require('../models/EmployeeKhata');
const KhataEntry = require('../models/KhataEntry');
const ledger = require('../services/khataLedger');

// Everything this script creates carries this marker, so cleanup can find it.
const TAG = 'khata-itest';

let passed = 0;
const failures = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

/** Run something expected to fail, and report the message rather than crashing. */
async function expectRejection(label, fn) {
  try { await fn(); failures.push(`${label}\n     expected it to be refused, but it went through`); console.log(` FAIL  ${label}`); }
  catch (err) { passed += 1; console.log(`  ok   ${label} (refused: ${err.message.slice(0, 60)}…)`); }
}

const balanceOf = async (khataId) => (await EmployeeKhata.findById(khataId)).balance;
const accountBalanceOf = async (id) => (await CashAccount.findById(id)).currentBalance;

async function run() {
  await mongoose.connect(TEST_URI);
  console.log(`\nconnected to ${TEST_URI.replace(/\/\/[^@]+@/, '//***@')}\n`);

  // ---- fixtures -----------------------------------------------------------
  const employee = await User.create({
    email: `${TAG}-employee@example.test`, password: 'test1234',
    firstName: 'Rahul', lastName: 'Sharma', role: 'Employee',
  });
  const supervisor = await User.create({
    email: `${TAG}-supervisor@example.test`, password: 'test1234',
    firstName: 'Anita', lastName: 'Desai', role: 'Employee', khataAccess: true,
  });
  const boss = await User.create({
    email: `${TAG}-boss@example.test`, password: 'test1234',
    firstName: 'Super', lastName: 'Admin', role: 'SuperAdmin',
  });

  const account = await CashAccount.create({
    name: `${TAG} Petty Cash`, type: 'PettyCash', openingBalance: 50000, currentBalance: 50000,
    operators: [{ user: supervisor._id, canDisburse: true, maxPerTransaction: 5000, canApprove: false }],
  });
  await ledger.recomputeCashAccount(account._id);

  const rights = ledger.resolveDisburseRights(supervisor, account);

  console.log('--- giving an advance moves both books ---');
  const { entry: adv, khata } = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance',
    amount: 5000, purpose: 'Site material purchase', cashAccount: account._id,
    autoApprove: ledger.willAutoApprove(rights, 5000),
  }, supervisor);

  check('the entry posted straight away', adv.status, 'Approved');
  check('the employee now owes 5000', await balanceOf(khata._id), 5000);
  check('the petty cash fell by 5000', await accountBalanceOf(account._id), 45000);
  check('a cashbook row was written', !!adv.cashbookEntry, true);
  const cashRow = await CashbookEntry.findById(adv.cashbookEntry);
  check('the cash leg is an "out"', cashRow.type, 'out');
  check('the cash row points back at the khata entry', String(cashRow.sourceKhataEntry), String(adv._id));
  check('the entry carries a quotable code', /^KHT-\d{4}-\d{5}$/.test(adv.code || ''), true);
  check('the running balance was stamped', (await KhataEntry.findById(adv._id)).balanceAfter, 5000);

  console.log('\n--- a replayed request must not pay twice ---');
  const key = `${TAG}-idem-1`;
  const first = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 1000,
    purpose: 'Conveyance', cashAccount: account._id, autoApprove: true, idempotencyKey: key,
  }, supervisor);
  const replay = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 1000,
    purpose: 'Conveyance', cashAccount: account._id, autoApprove: true, idempotencyKey: key,
  }, supervisor);
  check('the replay was recognised as a duplicate', replay.duplicate, true);
  check('it returned the original row', String(replay.entry._id), String(first.entry._id));
  check('the employee was charged once, not twice', await balanceOf(khata._id), 6000);
  check('the cash left the tin once', await accountBalanceOf(account._id), 44000);

  console.log('\n--- settling up ---');
  await ledger.postEntry({
    employee: employee._id, direction: 'from_employee', type: 'settlement',
    amount: 6000, purpose: 'Returned unspent cash', cashAccount: account._id, autoApprove: true,
  }, supervisor);
  check('the khata is square again', await balanceOf(khata._id), 0);
  check('the cash came back to the tin', await accountBalanceOf(account._id), 50000);

  console.log('\n--- an amount over the operator limit moves no cash until approved ---');
  const big = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance',
    amount: 20000, purpose: 'Equipment purchase', cashAccount: account._id,
    autoApprove: ledger.willAutoApprove(rights, 20000),
  }, supervisor);
  check('20000 parked rather than paying out', big.entry.status, 'Pending');
  check('the balance did not move', await balanceOf(khata._id), 0);
  check('no cash left the account', await accountBalanceOf(account._id), 50000);
  check('no cashbook row exists yet', big.entry.cashbookEntry, null);

  await ledger.approveEntry(await KhataEntry.findById(big.entry._id), boss, {});
  check('approving posts the money', await balanceOf(khata._id), 20000);
  check('and the cash finally leaves', await accountBalanceOf(account._id), 30000);

  console.log('\n--- a rejected request changes nothing ---');
  const spurned = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 3000,
    purpose: 'Not approved', autoApprove: false, raisedByEmployee: true,
  }, employee);
  await ledger.rejectEntry(await KhataEntry.findById(spurned.entry._id), boss, 'Not required');
  check('the balance is untouched by a rejection', await balanceOf(khata._id), 20000);
  check('and so is the cash account', await accountBalanceOf(account._id), 30000);

  console.log('\n--- the credit limit ---');
  await EmployeeKhata.findByIdAndUpdate(khata._id, { creditLimit: 25000 });
  await expectRejection('an advance past the limit is refused', () => ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 10000,
    purpose: 'Over limit', cashAccount: account._id, autoApprove: true,
  }, boss));
  check('nothing was recorded by the refused attempt', await balanceOf(khata._id), 20000);
  await EmployeeKhata.findByIdAndUpdate(khata._id, { creditLimit: 0 });

  console.log('\n--- reversing a posted entry squares both books, deleting nothing ---');
  const beforeCount = await KhataEntry.countDocuments({ khata: khata._id });
  const posted = await KhataEntry.findById(big.entry._id);
  const { original, reversal } = await ledger.reverseEntry(posted, boss, 'Wrong amount entered');
  check('the original is marked reversed, not deleted', original.status, 'Reversed');
  check('the original still exists', !!(await KhataEntry.findById(original._id)), true);
  check('a mirror row was written', reversal.direction, 'from_employee');
  check('the ledger grew by one row', await KhataEntry.countDocuments({ khata: khata._id }), beforeCount + 1);
  check('the khata is back to zero', await balanceOf(khata._id), 0);
  check('and so is the cash account', await accountBalanceOf(account._id), 50000);
  await expectRejection('the same entry cannot be reversed twice',
    async () => ledger.reverseEntry(await KhataEntry.findById(original._id), boss, 'again'));
  await expectRejection('a reversal needs a reason', async () => {
    const e = await ledger.postEntry({
      employee: employee._id, direction: 'to_employee', amount: 100, type: 'advance',
      purpose: 'x', cashAccount: account._id, autoApprove: true,
    }, boss);
    return ledger.reverseEntry(await KhataEntry.findById(e.entry._id), boss, '   ');
  });

  console.log('\n--- a back-dated entry re-stamps every later running balance ---');
  // Wipe the ledger for a clean, readable sequence.
  await KhataEntry.deleteMany({ khata: khata._id });
  await ledger.recomputeKhataBalance(khata._id);
  const on = (d) => new Date(`2026-03-${d}T10:00:00Z`);
  for (const [day, amount] of [['10', 1000], ['20', 2000]]) {
    await ledger.postEntry({
      employee: employee._id, direction: 'to_employee', type: 'advance', amount,
      date: on(day), purpose: `advance ${day}`, cashAccount: account._id, autoApprove: true,
    }, boss);
  }
  check('two advances total 3000', await balanceOf(khata._id), 3000);
  // Now insert a settlement dated BETWEEN them.
  await ledger.postEntry({
    employee: employee._id, direction: 'from_employee', type: 'settlement', amount: 500,
    date: on('15'), purpose: 'back-dated settlement', cashAccount: account._id, autoApprove: true,
  }, boss);
  const trail = await KhataEntry.find({ khata: khata._id, status: 'Approved' })
    .sort({ date: 1, createdAt: 1 }).select('balanceAfter');
  check('every running balance was re-derived in date order',
    trail.map((e) => e.balanceAfter), [1000, 500, 2500]);
  check('the closing balance is right', await balanceOf(khata._id), 2500);

  console.log('\n--- several khatas on one employee ---');
  const siteA = await EmployeeKhata.create({ employee: employee._id, name: `${TAG} Site A`, createdBy: boss._id });
  const vehicle = await EmployeeKhata.create({ employee: employee._id, name: `${TAG} Vehicle`, createdBy: boss._id });
  check('a second and third book can be opened', await EmployeeKhata.countDocuments({ employee: employee._id }), 3);
  await expectRejection('two books cannot share a name on one employee',
    () => EmployeeKhata.create({ employee: employee._id, name: `${TAG} Site A` }));

  // Money must land on the book it was aimed at, and nowhere else.
  await ledger.postEntry({
    employee: employee._id, khata: siteA._id, direction: 'to_employee', type: 'advance',
    amount: 4000, purpose: 'site materials', cashAccount: account._id, autoApprove: true,
  }, boss);
  await ledger.postEntry({
    employee: employee._id, khata: vehicle._id, direction: 'to_employee', type: 'advance',
    amount: 1500, purpose: 'fuel', cashAccount: account._id, autoApprove: true,
  }, boss);

  check('the site float holds its own amount', await balanceOf(siteA._id), 4000);
  check('the vehicle float holds its own amount', await balanceOf(vehicle._id), 1500);
  check('the original khata is untouched by either', await balanceOf(khata._id), 2500);

  // Settling one book must not touch the others.
  await ledger.postEntry({
    employee: employee._id, khata: siteA._id, direction: 'from_employee', type: 'settlement',
    amount: 4000, purpose: 'returned', cashAccount: account._id, autoApprove: true,
  }, boss);
  check('settling one book squares only that book', await balanceOf(siteA._id), 0);
  check('and leaves the other standing', await balanceOf(vehicle._id), 1500);

  // The ownership check: naming somebody else's book must be refused outright,
  // or one person's advance would post onto another person's ledger.
  const otherKhata = await EmployeeKhata.create({ employee: supervisor._id, name: `${TAG} Someone else` });
  await expectRejection("one employee's money cannot post to another's khata",
    () => ledger.postEntry({
      employee: employee._id, khata: otherKhata._id, direction: 'to_employee', type: 'advance',
      amount: 100, purpose: 'wrong book', cashAccount: account._id, autoApprove: true,
    }, boss));

  // A closed book takes nothing further.
  vehicle.isActive = false;
  await vehicle.save();
  await expectRejection('a closed khata refuses new entries',
    () => ledger.postEntry({
      employee: employee._id, khata: vehicle._id, direction: 'to_employee', type: 'advance',
      amount: 100, purpose: 'after close', cashAccount: account._id, autoApprove: true,
    }, boss));

  // Limits are per book, not per person.
  siteA.creditLimit = 5000;
  await siteA.save();
  await expectRejection('a per-khata limit blocks that khata',
    () => ledger.postEntry({
      employee: employee._id, khata: siteA._id, direction: 'to_employee', type: 'advance',
      amount: 6000, purpose: 'over the site limit', cashAccount: account._id, autoApprove: true,
    }, boss));
  const stillFine = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance',
    amount: 6000, purpose: 'onto the default book', cashAccount: account._id, autoApprove: true,
  }, boss);
  check("another book's limit does not apply", stillFine.entry.status, 'Approved');

  // Naming no khata falls back to the employee's default, not to any other book.
  check('an unnamed entry lands on the default book', String(stillFine.entry.khata), String(khata._id));

  // ---- cleanup ------------------------------------------------------------
  console.log('\ncleaning up…');
  await KhataEntry.deleteMany({ employee: { $in: [employee._id, supervisor._id] } });
  await EmployeeKhata.deleteMany({ employee: { $in: [employee._id, supervisor._id] } });
  await CashbookEntry.deleteMany({ account: account._id });
  await CashAccount.deleteOne({ _id: account._id });
  await User.deleteMany({ email: /^khata-itest-/ });

  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed.`);
  failures.forEach((f) => console.error(`\n  * ${f}`));
  await mongoose.disconnect();
  process.exit(failures.length ? 1 : 0);
}

run().catch(async (err) => {
  console.error('\nintegration run crashed:', err);
  try { await mongoose.disconnect(); } catch (_) { /* already down */ }
  process.exit(1);
});
