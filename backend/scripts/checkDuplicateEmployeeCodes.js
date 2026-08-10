/**
 * Report employee codes held by more than one profile, and confirm the unique
 * index behind them is actually in place.
 *
 * Why this exists: `employeeCode` is declared `unique: true` on the schema, but
 * Mongo refuses to BUILD a unique index over data that already violates it. If
 * duplicates were created before the constraint was added, the index silently
 * never comes up and the database stops being the last line of defence. The
 * controllers check for a clash before writing either way, so this script is a
 * one-off audit: clear the duplicates it lists, then re-run to build the index.
 *
 * Run (from backend/):
 *   node scripts/checkDuplicateEmployeeCodes.js            # report only
 *   node scripts/checkDuplicateEmployeeCodes.js --fix-index  # also build the index
 *
 * Writes nothing to any profile — resolving a duplicate is a human decision
 * (which of the two people keeps the code).
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const EmployeeProfile = require('../models/EmployeeProfile');

const FIX_INDEX = process.argv.includes('--fix-index');

async function main() {
  await connectDB();

  const dupes = await EmployeeProfile.aggregate([
    { $group: { _id: '$employeeCode', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  if (!dupes.length) {
    console.log('No duplicate employee codes.');
  } else {
    console.log(`${dupes.length} duplicated employee code(s):\n`);
    for (const d of dupes) {
      const profiles = await EmployeeProfile.find({ _id: { $in: d.ids } })
        .select('_id employeeCode dateOfJoining user')
        .populate('user', 'firstName lastName email');
      console.log(`  ${d._id}  ×${d.count}`);
      profiles.forEach((p) => {
        const u = p.user;
        const name = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '(no user)';
        console.log(`    - ${p._id}  ${name}  ${u?.email || ''}  joined ${p.dateOfJoining ? p.dateOfJoining.toISOString().slice(0, 10) : '-'}`);
      });
    }
    console.log('\nGive each of these a distinct code before the unique index can build.');
  }

  // Is the constraint actually live in this database?
  const indexes = await EmployeeProfile.collection.indexes();
  const codeIndex = indexes.find((i) => i.key && i.key.employeeCode === 1);
  if (codeIndex?.unique) {
    console.log('\nUnique index on employeeCode: present.');
  } else {
    console.log(`\nUnique index on employeeCode: MISSING${codeIndex ? ' (exists but is not unique)' : ''}.`);
    if (FIX_INDEX) {
      if (dupes.length) {
        console.log('Not building it — clear the duplicates above first.');
      } else {
        if (codeIndex) await EmployeeProfile.collection.dropIndex(codeIndex.name);
        await EmployeeProfile.collection.createIndex({ employeeCode: 1 }, { unique: true });
        console.log('Built unique index on employeeCode.');
      }
    } else {
      console.log('Re-run with --fix-index to build it.');
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
