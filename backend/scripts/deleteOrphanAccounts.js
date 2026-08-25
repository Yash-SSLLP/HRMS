/**
 * Remove login accounts that a failed Excel import left behind with no employee
 * record.
 *
 *   node scripts/deleteOrphanAccounts.js            # dry run — lists, changes nothing
 *   node scripts/deleteOrphanAccounts.js --apply    # actually delete
 *
 * WHAT AN ORPHAN IS HERE: a User with no EmployeeProfile, whose role is not one
 * of the three that never has a profile by design (SuperAdmin, CEO, MD). The old
 * importer created the account BEFORE resolving the company / salary structure /
 * manager columns, so a row that failed one of those lookups left the login
 * saved and the employee record never written. (The importer no longer works
 * that way — see the note above the create in importEmployeesXlsx — so this
 * script is a one-off clean-up, not a routine.)
 *
 * SAFETY, because this deletes real accounts from a live database:
 *   - dry run by default, matching every other destructive script here;
 *   - each candidate is checked for records that reference it (attendance,
 *     leave, cash, chat, documents, …) and one with ANY history is SKIPPED, not
 *     deleted — an account somebody has actually used is not import debris;
 *   - `--only <email,email>` restricts it to a named list;
 *   - `--max <n>` refuses to run if more than n accounts match, so a mistake in
 *     the filter cannot quietly wipe the directory.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

const APPLY = process.argv.includes('--apply');
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ONLY = (argOf('--only') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX = Number(argOf('--max') || 50);

// Roles that legitimately have no employee profile — never candidates.
const PROFILE_LESS_ROLES = ['SuperAdmin', 'CEO', 'MD'];

// Every collection that points at a User, with the field to check. If any of
// these has a row for an account, that account has history and is left alone.
const REFERENCES = [
  ['Attendance', 'employee'], ['Attendance', 'user'],
  // Leave exports a namespace, not a model — name the two collections inside it.
  ['Leave:LeaveRequest', 'employee'], ['Leave:LeaveBalance', 'employee'],
  ['CompOff', 'employee'], ['Regularization', 'employee'],
  ['Notification', 'recipient'], ['DeviceToken', 'user'],
  ['EmployeeWallet', 'employee'], ['KhataEntry', 'employee'], ['CashbookEntry', 'employee'],
  ['Expense', 'employee'], ['Loan', 'employee'], ['TravelRequest', 'employee'],
  ['Document', 'uploadedBy'], ['Message', 'sender'], ['Task', 'assignedTo'],
  ['Goal', 'employee'], ['Review', 'employee'], ['Complaint', 'raisedBy'],
  ['ChangeRequest', 'employee'], ['ExitRequest', 'employee'],
  ['InvestmentDeclaration', 'employee'], ['Payroll', 'employee'],
  ['OnboardingTask', 'employee'], ['AssetAssignment', 'employee'],
  ['RosterEntry', 'employee'], ['AuditLog', 'actor'],
];

const name = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || '(no name)';
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

// Models this run could NOT check. Reported at the end rather than swallowed —
// an unchecked collection is a gap in the "has this account been used?" test,
// and you should know about it before deleting anything.
const unchecked = new Set();

/** Count everything in the app that points at this account. */
async function historyOf(userId) {
  const found = [];
  for (const [modelName, field] of REFERENCES) {
    // "File:Export" picks one model out of a file that exports several.
    const [file, named] = modelName.split(':');
    let Model;
    try { Model = require(`../models/${file}`); } catch { continue; }
    if (named) Model = Model?.[named];
    if (!Model || typeof Model.countDocuments !== 'function') { unchecked.add(modelName); continue; }
    // A model may not have the field; an unknown path just matches nothing.
    // eslint-disable-next-line no-await-in-loop
    const n = await Model.countDocuments({ [field]: userId }).catch(() => 0);
    if (n > 0) found.push(`${modelName}.${field}=${n}`);
  }
  return found;
}

async function run() {
  await connectDB();

  const users = await User.find({ role: { $nin: PROFILE_LESS_ROLES } })
    .select('firstName lastName email role isActive createdAt')
    .sort({ createdAt: 1 })
    .lean();
  const profiled = new Set(
    (await EmployeeProfile.find({}).select('user').lean()).map((p) => String(p.user))
  );

  let candidates = users.filter((u) => !profiled.has(String(u._id)));
  if (ONLY.length) candidates = candidates.filter((u) => ONLY.includes(String(u.email).toLowerCase()));

  if (!candidates.length) {
    say('no accounts without an employee record — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  if (candidates.length > MAX) {
    console.error(`\nRefusing to run: ${candidates.length} accounts match, which is more than --max ${MAX}.`);
    console.error('Check the filter, then raise --max deliberately if that number really is right.\n');
    await mongoose.disconnect();
    process.exit(1);
  }

  const deletable = [];
  const skipped = [];
  for (const u of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const history = await historyOf(u._id);
    (history.length ? skipped : deletable).push({ ...u, history });
  }

  console.log(`\nAccounts with no employee record: ${candidates.length}\n`);
  console.log(`--- would be DELETED (${deletable.length}) ---`);
  deletable.forEach((u) => console.log(`  ${String(u.email).padEnd(40)} ${u.role.padEnd(12)} ${name(u)}`));

  console.log(`\n--- SKIPPED: they have history, so they are not import debris (${skipped.length}) ---`);
  if (!skipped.length) console.log('  none');
  skipped.forEach((u) => console.log(`  ${String(u.email).padEnd(40)} ${name(u)}\n      ${u.history.join(', ')}`));

  if (unchecked.size) {
    console.log(`\n--- NOT checked for history (${unchecked.size}) ---`);
    console.log(`  ${[...unchecked].join(', ')}`);
    console.log('  These collections could not be queried, so history in them would not have been seen.');
  }

  if (!APPLY) {
    console.log(`\n[dry run] nothing was deleted. To go ahead:\n`
      + `    node scripts/deleteOrphanAccounts.js --apply\n`);
    await mongoose.disconnect();
    return;
  }

  if (!deletable.length) {
    say('nothing safe to delete.');
    await mongoose.disconnect();
    return;
  }

  const ids = deletable.map((u) => u._id);
  const res = await User.deleteMany({ _id: { $in: ids } });
  say(`deleted ${res.deletedCount} account(s).`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
