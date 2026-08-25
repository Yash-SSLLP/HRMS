/**
 * READ-ONLY diagnostic: what did the Excel imports actually leave behind?
 *
 *   node scripts/auditImportedAccounts.js
 *
 * Writes NOTHING. It exists because "the import made users, not employees" and
 * "delete the old data" both need the same question answered first: which
 * accounts exist with no employee record behind them, and when were they made?
 *
 * An EmployeeProfile cannot exist without a User (`user` is required+unique), so
 * the failure mode worth looking for is the other way round: a User created by
 * an import whose profile never landed, leaving a login that is nobody.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

const DEFAULT_IMPORT_PASSWORD = 'Welcome@123';

// Roles that deliberately have NO employee profile — they are not employees, so
// their lack of one is correct and must not be read as import damage.
const PROFILE_LESS_ROLES = ['SuperAdmin', 'CEO', 'MD'];

const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—');
const name = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || '(no name)';

async function run() {
  await connectDB();

  const [users, profiles] = await Promise.all([
    User.find({}).select('firstName lastName email role isActive createdAt').sort({ createdAt: 1 }).lean(),
    EmployeeProfile.find({}).select('user employeeCode createdAt company').lean(),
  ]);

  const withProfile = new Set(profiles.map((p) => String(p.user)));
  const orphans = users.filter((u) => !withProfile.has(String(u._id)) && !PROFILE_LESS_ROLES.includes(u.role));
  const danglingProfiles = profiles.filter((p) => !users.some((u) => String(u._id) === String(p.user)));

  console.log(`\n  Users:             ${users.length}`);
  console.log(`  Employee profiles: ${profiles.length}`);
  console.log(`  Profile-less by design (SuperAdmin/CEO/MD): `
    + `${users.filter((u) => PROFILE_LESS_ROLES.includes(u.role)).length}`);

  console.log(`\n=== Logins with NO employee record (${orphans.length}) ===`);
  if (!orphans.length) console.log('  none — every non-executive account has an employee profile.');
  orphans.forEach((u) => {
    console.log(`  ${when(u.createdAt)}  ${u.role.padEnd(15)} ${String(u.email).padEnd(34)} ${name(u)}`
      + `${u.isActive === false ? '  [inactive]' : ''}`);
  });

  console.log(`\n=== Employee profiles whose user is gone (${danglingProfiles.length}) ===`);
  if (!danglingProfiles.length) console.log('  none.');
  danglingProfiles.forEach((p) => console.log(`  ${when(p.createdAt)}  ${p.employeeCode}`));

  // Accounts still on the import default password are almost certainly imported
  // and never signed into — useful for telling "old import junk" from real staff.
  const stillDefault = [];
  for (const u of users) {
    // eslint-disable-next-line no-await-in-loop
    const full = await User.findById(u._id).select('+password');
    // eslint-disable-next-line no-await-in-loop
    if (full && await full.matchPassword?.(DEFAULT_IMPORT_PASSWORD).catch(() => false)) stillDefault.push(u);
  }
  console.log(`\n=== Still on the default import password "${DEFAULT_IMPORT_PASSWORD}" (${stillDefault.length}) ===`);
  stillDefault.forEach((u) => console.log(`  ${when(u.createdAt)}  ${u.role.padEnd(15)} ${String(u.email).padEnd(34)} ${name(u)}`));

  console.log('\n=== All accounts, oldest first ===');
  users.forEach((u) => {
    const p = profiles.find((x) => String(x.user) === String(u._id));
    console.log(`  ${when(u.createdAt)}  ${u.role.padEnd(15)} ${String(u.email).padEnd(34)} `
      + `${(p ? p.employeeCode : '— no profile —').padEnd(12)} ${name(u)}`);
  });

  console.log('\nRead-only: nothing was changed.\n');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
