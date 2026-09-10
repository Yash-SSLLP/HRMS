/**
 * Turn the retired `User.incentiveAccess` boolean into a real incentive role.
 *
 * Until 2026-09-10 incentive access was one switch: on meant "can do everything
 * in the module". It is now a ROLE PER TAB (see config/incentiveRoles.js),
 * because a manager and a picker need very different things. Everybody who held
 * the old switch had full access, so they become **manager of every incentive**
 * (`{ module: 'all', role: 'manager' }`) — the assignment that means the same
 * thing under the new model.
 *
 * NOBODY IS LOCKED OUT WHILE THIS IS PENDING: `incentiveRole` still reads a
 * leftover `incentiveAccess: true` as a manager. This script exists so that the
 * Permissions dropdown shows the truth (a boolean it cannot display would read
 * as "None"), and so the fallback can eventually be deleted.
 *
 * Run (from backend/):
 *   node scripts/migrateIncentiveRoles.js          # report only
 *   node scripts/migrateIncentiveRoles.js --apply  # actually migrate
 *
 * Safe to re-run: accounts that already carry a role are left alone.
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const mongoose = require('mongoose');
const User = require('../models/User');
const { ALL_MODULES } = require('../config/incentiveRoles');

const APPLY = process.argv.includes('--apply');
// These four run every incentive by role, so an assignment on them is noise.
const BY_ROLE = ['SuperAdmin', 'HRManager', 'CEO', 'MD'];

async function main() {
  await connectDB();

  const holders = await User.find({ incentiveAccess: true })
    .select('firstName lastName email role incentiveRoles').lean();
  console.log(`${holders.length} account(s) still carry the old incentiveAccess switch.`);

  const toRole = [];
  const justClear = [];
  for (const u of holders) {
    const name = `${u.firstName} ${u.lastName} (${u.role})`;
    if (BY_ROLE.includes(u.role)) {
      justClear.push({ u, name, why: 'runs every incentive by role already' });
    } else if ((u.incentiveRoles || []).length) {
      justClear.push({ u, name, why: `already has a role: ${u.incentiveRoles.map((r) => `${r.module}/${r.role}`).join(', ')}` });
    } else {
      toRole.push({ u, name });
    }
  }

  if (toRole.length) {
    console.log('\nBecoming manager of every incentive:');
    toRole.forEach(({ name }) => console.log(`  ${name}`));
  }
  if (justClear.length) {
    console.log('\nSwitch cleared, no role added:');
    justClear.forEach(({ name, why }) => console.log(`  ${name} — ${why}`));
  }

  if (!APPLY) {
    console.log('\n(dry run — pass --apply to migrate)');
    return;
  }

  for (const { u } of toRole) {
    await User.updateOne(
      { _id: u._id },
      { $set: { incentiveRoles: [{ module: ALL_MODULES, role: 'manager' }], incentiveAccess: false } },
    );
  }
  for (const { u } of justClear) {
    await User.updateOne({ _id: u._id }, { $set: { incentiveAccess: false } });
  }
  console.log(`\nMigrated ${toRole.length}, cleared ${justClear.length}.`);
  console.log('Everybody keeps the access they had; the Permissions page now shows it.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
