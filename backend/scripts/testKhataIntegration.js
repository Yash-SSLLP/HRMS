/**
 * End-to-end check of the employee wallet/khata ledger against a real database.
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
 *   - an advance moves the employee's WALLET and the company cash account, in
 *     opposite directions, with both rows cross-linked;
 *   - a replayed request pays out once, not twice;
 *   - an amount over the operator's limit moves NO cash until it is approved;
 *   - expenses filed against several books all come out of the one wallet, and
 *     each book totals only its own spending;
 *   - a reversal squares both books while deleting nothing;
 *   - a back-dated entry re-stamps every later running balance;
 *   - an advance awaiting an executive sanction reaches nobody's cash until it
 *     has one.
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
const EmployeeWallet = require('../models/EmployeeWallet');
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

/** How much of the company's cash this person is holding. */
const walletOf = async (employeeId) => (await EmployeeWallet.findOne({ employee: employeeId })).balance;
/** What one expense book has cost. */
const spentOn = async (khataId) => (await EmployeeKhata.findById(khataId)).spent;
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
  const ceo = await User.create({
    email: `${TAG}-ceo@example.test`, password: 'test1234',
    firstName: 'Meera', lastName: 'Rao', role: 'CEO',
  });

  const account = await CashAccount.create({
    name: `${TAG} Petty Cash`, type: 'PettyCash', openingBalance: 50000, currentBalance: 50000,
    operators: [{ user: supervisor._id, canDisburse: true, maxPerTransaction: 5000, canApprove: false }],
  });
  await ledger.recomputeCashAccount(account._id);

  const rights = ledger.resolveDisburseRights(supervisor, account);

  console.log('--- an advance moves the wallet and the cash account ---');
  const { entry: adv, wallet, khata } = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance',
    amount: 5000, purpose: 'Site material purchase', cashAccount: account._id,
    autoApprove: ledger.willAutoApprove(rights, 5000),
  }, supervisor);

  check('the entry posted straight away', adv.status, 'Approved');
  // The whole point of the wallet: an advance belongs to the PERSON, not to any
  // one of their expense books.
  check('an advance is filed against no khata', adv.khata, null);
  check('the employee is holding 5000', await walletOf(employee._id), 5000);
  check('the wallet came back from postEntry', wallet.balance, 5000);
  check('no khata was involved', khata, null);
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
  check('the employee was given it once, not twice', await walletOf(employee._id), 6000);
  check('the cash left the tin once', await accountBalanceOf(account._id), 44000);

  console.log('\n--- returning unspent cash ---');
  await ledger.postEntry({
    employee: employee._id, direction: 'from_employee', type: 'settlement',
    amount: 6000, purpose: 'Returned unspent cash', cashAccount: account._id, autoApprove: true,
  }, supervisor);
  check('the wallet is empty again', await walletOf(employee._id), 0);
  check('the cash came back to the tin', await accountBalanceOf(account._id), 50000);

  console.log('\n--- an amount over the operator limit moves no cash until approved ---');
  const big = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance',
    amount: 20000, purpose: 'Equipment purchase', cashAccount: account._id,
    autoApprove: ledger.willAutoApprove(rights, 20000),
  }, supervisor);
  check('20000 parked rather than paying out', big.entry.status, 'Pending');
  check('the wallet did not move', await walletOf(employee._id), 0);
  check('no cash left the account', await accountBalanceOf(account._id), 50000);
  check('no cashbook row exists yet', big.entry.cashbookEntry, null);

  await ledger.approveEntry(await KhataEntry.findById(big.entry._id), boss, {});
  check('approving posts the money', await walletOf(employee._id), 20000);
  check('and the cash finally leaves', await accountBalanceOf(account._id), 30000);

  console.log('\n--- a rejected request changes nothing ---');
  const spurned = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 3000,
    purpose: 'Not approved', autoApprove: false, raisedByEmployee: true,
  }, employee);
  await ledger.rejectEntry(await KhataEntry.findById(spurned.entry._id), boss, 'Not required');
  check('the wallet is untouched by a rejection', await walletOf(employee._id), 20000);
  check('and so is the cash account', await accountBalanceOf(account._id), 30000);

  console.log('\n--- the advance limit is per person, not per book ---');
  await EmployeeWallet.updateOne({ employee: employee._id }, { $set: { creditLimit: 25000 } });
  await expectRejection('an advance past the limit is refused', () => ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 10000,
    purpose: 'Over limit', cashAccount: account._id, autoApprove: true,
  }, boss));
  check('nothing was recorded by the refused attempt', await walletOf(employee._id), 20000);
  await EmployeeWallet.updateOne({ employee: employee._id }, { $set: { creditLimit: 0 } });

  console.log('\n--- reversing a posted entry squares both books, deleting nothing ---');
  const beforeCount = await KhataEntry.countDocuments({ employee: employee._id });
  const posted = await KhataEntry.findById(big.entry._id);
  const { original, reversal } = await ledger.reverseEntry(posted, boss, 'Wrong amount entered');
  check('the original is marked reversed, not deleted', original.status, 'Reversed');
  check('the original still exists', !!(await KhataEntry.findById(original._id)), true);
  check('a mirror row was written', reversal.direction, 'from_employee');
  check('the ledger grew by one row', await KhataEntry.countDocuments({ employee: employee._id }), beforeCount + 1);
  check('the wallet is back to zero', await walletOf(employee._id), 0);
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
  await KhataEntry.deleteMany({ employee: employee._id });
  await ledger.recomputeWalletBalance(employee._id);
  const on = (d) => new Date(`2026-03-${d}T10:00:00Z`);
  for (const [day, amount] of [['10', 1000], ['20', 2000]]) {
    await ledger.postEntry({
      employee: employee._id, direction: 'to_employee', type: 'advance', amount,
      date: on(day), purpose: `advance ${day}`, cashAccount: account._id, autoApprove: true,
    }, boss);
  }
  check('two advances total 3000', await walletOf(employee._id), 3000);
  // Now insert a settlement dated BETWEEN them.
  await ledger.postEntry({
    employee: employee._id, direction: 'from_employee', type: 'settlement', amount: 500,
    date: on('15'), purpose: 'back-dated settlement', cashAccount: account._id, autoApprove: true,
  }, boss);
  const trail = await KhataEntry.find({ employee: employee._id, status: 'Approved' })
    .sort({ date: 1, createdAt: 1 }).select('balanceAfter');
  check('every running balance was re-derived in date order',
    trail.map((e) => e.balanceAfter), [1000, 500, 2500]);
  check('the closing balance is right', await walletOf(employee._id), 2500);

  console.log('\n--- one wallet, several expense books ---');
  const general = await ledger.getOrCreateDefaultKhata(employee._id, boss);
  const siteA = await EmployeeKhata.create({ employee: employee._id, name: `${TAG} Site A`, createdBy: boss._id });
  const vehicle = await EmployeeKhata.create({ employee: employee._id, name: `${TAG} Vehicle`, createdBy: boss._id });
  check('a second and third book can be opened', await EmployeeKhata.countDocuments({ employee: employee._id }), 3);
  await expectRejection('two books cannot share a name on one employee',
    () => EmployeeKhata.create({ employee: employee._id, name: `${TAG} Site A` }));

  // Spending is filed per book but comes out of the ONE pot. This is the
  // behaviour the whole redesign exists for: 2500 in hand, spend 1000 on site
  // materials and 400 on fuel, and 1100 is left whichever book you look at.
  await ledger.postEntry({
    employee: employee._id, khata: siteA._id, direction: 'from_employee', type: 'expense',
    amount: 1000, purpose: 'cement', affectsCompanyCash: false, autoApprove: true,
  }, boss);
  await ledger.postEntry({
    employee: employee._id, khata: vehicle._id, direction: 'from_employee', type: 'expense',
    amount: 400, purpose: 'diesel', affectsCompanyCash: false, autoApprove: true,
  }, boss);

  check('the site book records its own spend', await spentOn(siteA._id), 1000);
  check('the vehicle book records its own spend', await spentOn(vehicle._id), 400);
  check('the untouched book stays at zero', await spentOn(general._id), 0);
  check('both came out of the same wallet', await walletOf(employee._id), 1100);
  // No company cash moved: it left the tin when the advance was paid.
  check('recording spend moves no company cash', await accountBalanceOf(account._id), 50000);

  // The ownership check: naming somebody else's book must be refused outright,
  // or one person's spending would post onto another person's ledger.
  const otherKhata = await EmployeeKhata.create({ employee: supervisor._id, name: `${TAG} Someone else` });
  await expectRejection("one employee's spend cannot post to another's khata",
    () => ledger.postEntry({
      employee: employee._id, khata: otherKhata._id, direction: 'from_employee', type: 'expense',
      amount: 100, purpose: 'wrong book', affectsCompanyCash: false, autoApprove: true,
    }, boss));

  // A closed book takes nothing further.
  vehicle.isActive = false;
  await vehicle.save();
  await expectRejection('a closed khata refuses new expenses',
    () => ledger.postEntry({
      employee: employee._id, khata: vehicle._id, direction: 'from_employee', type: 'expense',
      amount: 100, purpose: 'after close', affectsCompanyCash: false, autoApprove: true,
    }, boss));

  // Naming no khata on an expense falls back to the employee's default.
  const unfiled = await ledger.postEntry({
    employee: employee._id, direction: 'from_employee', type: 'expense',
    amount: 100, purpose: 'unfiled spend', affectsCompanyCash: false, autoApprove: true,
  }, boss);
  check('an unnamed expense lands on the default book', String(unfiled.entry.khata), String(general._id));

  // Reversing an expense takes the cost back off the book it was charged to.
  await ledger.reverseEntry(await KhataEntry.findById(unfiled.entry._id), boss, 'not ours');
  check('reversing an expense un-charges the book', await spentOn(general._id), 0);
  check('and puts the money back in the wallet', await walletOf(employee._id), 1100);

  console.log('\n--- the executive sanction gate ---');
  const asked = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 7000,
    purpose: 'New site float', autoApprove: false, raisedByEmployee: true,
    status: 'AwaitingApproval', execApprovalRequired: true,
  }, employee);
  check('the request waits on an executive', asked.entry.status, 'AwaitingApproval');
  check('the wallet has not moved', await walletOf(employee._id), 1100);
  await expectRejection('the accounts team cannot pay it before it is sanctioned',
    async () => ledger.approveEntry(await KhataEntry.findById(asked.entry._id), boss, { cashAccount: account._id }));

  const sanctioned = await ledger.decideExecApproval(await KhataEntry.findById(asked.entry._id), ceo, true, 'Fine');
  // Sanctioning decides WHETHER, not WHERE FROM — so it lands in the operators'
  // queue rather than paying out.
  check('a sanction hands it to the accounts team', sanctioned.status, 'Pending');
  check('sanctioning alone moves no money', await walletOf(employee._id), 1100);
  check('the sanction is recorded against the executive', String(sanctioned.execApprovedBy), String(ceo._id));
  await expectRejection('it cannot be sanctioned twice',
    async () => ledger.decideExecApproval(await KhataEntry.findById(asked.entry._id), ceo, true, 'again'));

  await ledger.approveEntry(await KhataEntry.findById(asked.entry._id), boss, { cashAccount: account._id });
  check('only then does the cash move', await walletOf(employee._id), 8100);

  const refused = await ledger.postEntry({
    employee: employee._id, direction: 'to_employee', type: 'advance', amount: 9000,
    purpose: 'Another float', autoApprove: false, raisedByEmployee: true,
    status: 'AwaitingApproval', execApprovalRequired: true,
  }, employee);
  const declined = await ledger.decideExecApproval(await KhataEntry.findById(refused.entry._id), ceo, false, 'Not now');
  check('a declined request is rejected outright', declined.status, 'Rejected');
  check('and never reaches the wallet', await walletOf(employee._id), 8100);

  // ---- cleanup ------------------------------------------------------------
  console.log('\ncleaning up…');
  await KhataEntry.deleteMany({ employee: { $in: [employee._id, supervisor._id] } });
  await EmployeeKhata.deleteMany({ employee: { $in: [employee._id, supervisor._id] } });
  await EmployeeWallet.deleteMany({ employee: { $in: [employee._id, supervisor._id] } });
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
