/**
 * Migrate the employee khata from one-book-per-person to many named books.
 *
 *   node scripts/migrateMultiKhata.js          # report what it would do
 *   node scripts/migrateMultiKhata.js --apply  # actually do it
 *
 * WHY THIS IS NEEDED AT ALL. `EmployeeKhata.employee` used to be declared
 * `unique: true`. Removing that from the schema does NOT remove the index from
 * MongoDB — Mongoose only ever creates indexes, it never drops them. Left in
 * place, the old index rejects an employee's second khata with a duplicate-key
 * error that reads like a bug. So this script drops it explicitly.
 *
 * It also gives every existing khata a name and marks it as the employee's
 * default, since rows created before this change have neither.
 *
 * Safe to run more than once: each step checks whether it is still needed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const EmployeeKhata = require('../models/EmployeeKhata');
const { DEFAULT_KHATA_NAME } = require('../models/EmployeeKhata');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

async function run() {
  await connectDB();
  const collection = EmployeeKhata.collection;

  // ---- 1. Drop the old one-khata-per-employee unique index ----------------
  // Identified by shape rather than by name, because the name Mongo generated
  // depends on how the index was first created.
  const indexes = await collection.indexes();
  const stale = indexes.find((i) => i.unique
    && Object.keys(i.key).length === 1
    && i.key.employee === 1);

  if (stale) {
    say(`dropping stale unique index "${stale.name}" on { employee: 1 }`);
    if (APPLY) await collection.dropIndex(stale.name);
  } else {
    console.log('  no stale unique index on { employee: 1 } — nothing to drop');
  }

  // ---- 2. Name every unnamed khata ---------------------------------------
  const unnamed = await EmployeeKhata.countDocuments({
    $or: [{ name: { $exists: false } }, { name: null }, { name: '' }],
  });
  if (unnamed) {
    say(`naming ${unnamed} khata(s) "${DEFAULT_KHATA_NAME}"`);
    if (APPLY) {
      await collection.updateMany(
        { $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] },
        { $set: { name: DEFAULT_KHATA_NAME } }
      );
    }
  } else {
    console.log('  every khata already has a name');
  }

  // ---- 3. Mark one default per employee ----------------------------------
  // The oldest book is the one self-service used to land on, so it stays the
  // fallback. Employees who already have a default are left alone.
  const withoutDefault = await EmployeeKhata.aggregate([
    { $group: { _id: '$employee', hasDefault: { $max: { $cond: ['$isDefault', 1, 0] } } } },
    { $match: { hasDefault: 0 } },
  ]);

  if (withoutDefault.length) {
    say(`marking a default khata for ${withoutDefault.length} employee(s)`);
    if (APPLY) {
      for (const row of withoutDefault) {
        const oldest = await EmployeeKhata.findOne({ employee: row._id }).sort({ createdAt: 1 });
        if (oldest) {
          oldest.isDefault = true;
          await oldest.save();
        }
      }
    }
  } else {
    console.log('  every employee already has a default khata');
  }

  // ---- 4. Build the new compound index ------------------------------------
  if (APPLY) {
    await EmployeeKhata.syncIndexes();
    console.log('  indexes synced — { employee, name } is now the unique key');
  } else {
    say('would sync indexes to create the unique { employee, name } key');
  }

  if (!APPLY) console.log('\nNothing was changed. Re-run with --apply to make it so.');
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error('migration failed:', err);
  try { await mongoose.disconnect(); } catch (_) { /* already down */ }
  process.exit(1);
});
