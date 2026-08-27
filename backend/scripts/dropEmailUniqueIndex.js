/**
 * Drop the legacy UNIQUE index on User.email and replace it with a plain one.
 *
 * Why this exists: when an employee resigns, their work address is reissued to
 * whoever fills the seat, so two accounts legitimately share it. The unique
 * index refuses that with a duplicate-key error at account creation. The
 * schema no longer declares `unique` (see models/User.js), but Mongo does NOT
 * drop an index just because the schema stopped asking for it — the old
 * `email_1` index stays on the collection until it is dropped by hand.
 *
 * Sign-in does not depend on the address any more; people log in with their
 * employee code (see utils/loginIdentity), so nothing is lost by allowing it.
 *
 * Run (from backend/):
 *   node scripts/dropEmailUniqueIndex.js          # report only
 *   node scripts/dropEmailUniqueIndex.js --apply  # actually change the index
 *
 * Safe to re-run: it reports and exits when the index is already non-unique.
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const mongoose = require('mongoose');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();
  const coll = User.collection;

  const indexes = await coll.indexes();
  const emailIdx = indexes.find((i) => i.key && i.key.email === 1);

  if (!emailIdx) {
    console.log('No index on email at all. Creating a plain one.');
    if (APPLY) await coll.createIndex({ email: 1 }, { name: 'email_1' });
    else console.log('(dry run — pass --apply to create it)');
    return;
  }

  console.log(`Found index "${emailIdx.name}" — unique: ${emailIdx.unique === true}`);
  if (!emailIdx.unique) {
    console.log('Already non-unique. Nothing to do.');
    return;
  }

  // Report what is about to become possible, so the operator sees the state
  // they are moving from.
  const dupes = await User.aggregate([
    { $group: { _id: '$email', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  console.log(`Accounts sharing an address today: ${dupes.length} (the unique index guarantees 0).`);

  if (!APPLY) {
    console.log(`\nDry run. Would drop "${emailIdx.name}" and recreate it as a non-unique index.`);
    console.log('Re-run with --apply to do it.');
    return;
  }

  await coll.dropIndex(emailIdx.name);
  console.log(`Dropped "${emailIdx.name}".`);
  await coll.createIndex({ email: 1 }, { name: 'email_1' });
  console.log('Recreated email_1 as a non-unique index.');
}

main()
  .catch((err) => { console.error('Failed:', err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
