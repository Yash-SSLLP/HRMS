/**
 * Rename IncentiveEntry.leader -> IncentiveEntry.picker on documents already in
 * the database, and move the unique index with them.
 *
 * The field was renamed on 2026-09-10 (the day's lead is called the PICKER, in
 * the UI and now in the data). Mongoose renames nothing by itself: a document
 * written before the change keeps its `leader` sub-document, which the new code
 * cannot see at all — the entry would render with no picker and pay one share
 * too few.
 *
 * THE INDEX IS THE DANGEROUS HALF. The old `date_1_leader.employee_1` is UNIQUE
 * and Mongo keeps it until it is dropped by hand. Once documents no longer have
 * a `leader` field, every one of them indexes as (date, null) — so the second
 * team recorded on any day would be refused with a duplicate-key error. Dropping
 * it is not optional, and `syncIndexes()` below does that and builds the new one
 * in a single step.
 *
 * Run (from backend/):
 *   node scripts/renameLeaderToPicker.js          # report only
 *   node scripts/renameLeaderToPicker.js --apply  # actually migrate
 *
 * Safe to re-run: with nothing left to rename it reports and still reconciles
 * the indexes.
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const mongoose = require('mongoose');
const IncentiveEntry = require('../models/IncentiveEntry');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();
  const coll = IncentiveEntry.collection;

  const stale = await coll.countDocuments({ leader: { $exists: true } });
  const done = await coll.countDocuments({ picker: { $exists: true } });
  console.log(`${stale} document(s) still carry \`leader\`; ${done} already have \`picker\`.`);

  // A document with BOTH is the one case $rename refuses (it will not overwrite
  // an existing field), so say so plainly rather than dying on it mid-run.
  const both = await coll.countDocuments({ leader: { $exists: true }, picker: { $exists: true } });
  if (both) {
    console.error(`\n${both} document(s) have BOTH fields — $rename would fail on those.`);
    console.error('Look at them by hand before running this again:');
    const sample = await coll.find({ leader: { $exists: true }, picker: { $exists: true } })
      .project({ date: 1, teamName: 1 }).limit(5).toArray();
    sample.forEach((d) => console.error(`  ${d._id}  ${d.date}  ${d.teamName || ''}`));
    return;
  }

  if (stale && APPLY) {
    const res = await coll.updateMany({ leader: { $exists: true } }, { $rename: { leader: 'picker' } });
    console.log(`Renamed the field on ${res.modifiedCount} document(s).`);
  } else if (stale) {
    console.log('(dry run — pass --apply to rename them)');
  }

  const before = (await coll.indexes()).map((i) => i.name);
  console.log('\nIndexes now:', before.join(', '));
  if (APPLY) {
    // Drops whatever the schema no longer declares (the old unique index on
    // leader.employee) and creates whatever it does (the same rule on picker).
    const dropped = await IncentiveEntry.syncIndexes();
    console.log('Dropped:', dropped.length ? dropped.join(', ') : '(none)');
    console.log('Indexes after:', (await coll.indexes()).map((i) => i.name).join(', '));
  } else {
    console.log('(dry run — pass --apply to reconcile the indexes)');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
