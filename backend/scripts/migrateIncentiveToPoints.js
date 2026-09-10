/**
 * Move IncentiveEntry from rupees-per-rolling to sheets-and-points.
 *
 * What changed on 2026-09-10: a day used to record `rollings` and a rupee
 * `ratePerRolling`. It now records `sheets`, what a sheet yields in
 * `pointsPerSheet`, and what a point is worth in `rupeePerPoint` — and money is
 * derived from the points rather than being the primary figure.
 *
 * THE CONVERSION KEEPS THE MONEY EXACTLY. An old day becomes one point per
 * rolling (`pointsPerSheet: 1`) valued at the rupee rate it was saved with
 * (`rupeePerPoint: <old ratePerRolling>`), so `totalAmount` comes out the same
 * number it always was. That leaves a handful of historic days carrying an
 * unusual point value, which is correct: those figures are frozen on purpose, and
 * rewriting them to today's valuation would restate money already earned.
 *
 * NEW days are unaffected by any of that — they take the current defaults
 * (Incentive → Point Rate).
 *
 * The org setting moves too: `incentive.ratePerRolling` becomes
 * `incentive.rupeePerPoint`, and `pointsPerSheet` is seeded at 4. CHECK BOTH
 * AFTERWARDS — the old rate was rupees per rolling and the new one is rupees per
 * POINT, so if a sheet is now worth 4 points, leaving the number alone quadruples
 * what a day pays. This script cannot guess the intended figure; it only makes
 * sure a sensible one is there.
 *
 * Run (from backend/):
 *   node scripts/migrateIncentiveToPoints.js          # report only
 *   node scripts/migrateIncentiveToPoints.js --apply  # actually migrate
 *
 * Safe to re-run: documents already carrying `sheets` are left alone.
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const mongoose = require('mongoose');
const IncentiveEntry = require('../models/IncentiveEntry');
const Setting = require('../models/Setting');

const APPLY = process.argv.includes('--apply');

async function main() {
  await connectDB();
  const coll = IncentiveEntry.collection;

  const stale = await coll.find({ rollings: { $exists: true } }).toArray();
  const done = await coll.countDocuments({ sheets: { $exists: true } });
  console.log(`${stale.length} document(s) still on rollings; ${done} already on sheets.`);

  if (stale.length) {
    console.log('\nWhat each one becomes (money is preserved):');
    stale.slice(0, 10).forEach((d) => {
      const heads = (d.members || []).length + (d.picker || d.leader ? 1 : 0);
      const points = (d.rollings || 0) * 1;
      const money = Math.round(points * (d.ratePerRolling || 0) * 100) / 100;
      console.log(`  ${d.teamName || '(no name)'} ${new Date(d.date).toDateString()}`
        + `  ${d.rollings} rollings @ Rs ${d.ratePerRolling}`
        + `  ->  ${d.rollings} sheets x 1 point @ Rs ${d.ratePerRolling}/point`
        + `  = ${points} points, Rs ${money} over ${heads}`);
    });
    if (stale.length > 10) console.log(`  …and ${stale.length - 10} more`);
  }

  if (stale.length && APPLY) {
    for (const d of stale) {
      // One document at a time and through the MODEL, so the pre-save hook
      // recomputes every derived figure rather than this script duplicating the
      // arithmetic and drifting from it.
      await coll.updateOne({ _id: d._id }, {
        $rename: {
          rollings: 'sheets',
          rollingsFilledAt: 'sheetsFilledAt',
          rollingsFilledByName: 'sheetsFilledByName',
        },
      });
      await coll.updateOne({ _id: d._id }, {
        $set: { pointsPerSheet: 1, rupeePerPoint: d.ratePerRolling == null ? 1 : d.ratePerRolling },
        $unset: { ratePerRolling: '' },
      });
      const doc = await IncentiveEntry.findById(d._id);
      if (doc) await doc.save(); // recalc() runs in the pre-save hook
    }
    console.log(`\nMigrated ${stale.length} document(s).`);
  } else if (stale.length) {
    console.log('\n(dry run — pass --apply to migrate them)');
  }

  // ---- the org setting -------------------------------------------------------
  const raw = await Setting.collection.findOne({ singleton: 'global' });
  const cfg = (raw && raw.incentive) || {};
  console.log('\nSetting.incentive is now:', JSON.stringify(cfg));
  if (cfg.ratePerRolling !== undefined && cfg.rupeePerPoint === undefined) {
    console.log(`  -> rupeePerPoint: ${cfg.ratePerRolling} (carried over), pointsPerSheet: 4`);
    console.log('  NOTE: the old figure was rupees per ROLLING. Check it on');
    console.log('        Incentive -> Point Rate; it is now rupees per POINT.');
    if (APPLY) {
      await Setting.collection.updateOne({ singleton: 'global' }, {
        $set: {
          'incentive.rupeePerPoint': cfg.ratePerRolling,
          'incentive.pointsPerSheet': cfg.pointsPerSheet == null ? 4 : cfg.pointsPerSheet,
        },
        $unset: { 'incentive.ratePerRolling': '' },
      });
      console.log('  Setting updated.');
    } else {
      console.log('  (dry run — pass --apply)');
    }
  } else {
    console.log('  (nothing to carry over)');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close());
