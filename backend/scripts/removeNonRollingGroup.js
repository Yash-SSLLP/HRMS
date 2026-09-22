/**
 * Retire the NON-ROLLING GROUP and restate every day on the new arithmetic.
 *
 * Until 2026-09-22 a percentage of each team's points went to the department
 * members who had not rolled that day, and the two halves added back up to the
 * pot. That group is gone (user decision 2026-09-22): the percentage still comes
 * off every team, but it is settled outside the portal and nobody here is paid
 * out of it. See models/IncentiveEntry for the arithmetic that replaced it.
 *
 * WHAT THIS DOES, per IncentiveEntry:
 *   - renames  nonRollingSharePct -> deductionPct   (the frozen per-day figure)
 *   - drops    nonRolling, nonRollingPoints, rollingPoints,
 *              nonRollingHeadCount, perNonRollingPoints
 *   - recomputes grossPoints / deductionPoints / teamPoints / perPersonPoints
 *     and the two money figures, by running the model's own recalc()
 *
 * AND ON THE COMPANY SETTING: Setting.incentive.nonRollingSharePct becomes
 * deductionPct. (That field was never declared on the Setting schema, so strict
 * mode dropped every write of it and it is almost certainly absent — the rename
 * is here for the case where it is not.)
 *
 * TEAM POINTS BECOME NET, which RESTATES what every day is worth: a day that
 * read 40 reads 28 at a 30% deduction. That is the point of the change and it
 * was chosen deliberately, but it is a restatement of recorded figures, so read
 * the dry run before applying it. `payees()` drives every roll-up and payment
 * total, so each person's earned figure moves with the day.
 *
 * SAFE TO RE-RUN. recalc() is a pure function of the stored inputs, and the
 * renames are no-ops once done.
 *
 * Usage:
 *   node scripts/removeNonRollingGroup.js           # dry run, writes nothing
 *   node scripts/removeNonRollingGroup.js --apply   # actually writes
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const IncentiveEntry = require('../models/IncentiveEntry');
const { recalc, payees } = require('../models/IncentiveEntry');
const Setting = require('../models/Setting');

const APPLY = process.argv.includes('--apply');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  await connectDB();
  console.log(APPLY ? '\n=== APPLYING ===\n' : '\n=== DRY RUN (nothing is written) ===\n');

  // Read raw, so the fields the schema no longer declares are still visible.
  const raw = await mongoose.connection.db.collection('incentiveentries').find({}).toArray();
  console.log(`IncentiveEntry rows: ${raw.length}`);

  const withGroup = raw.filter((e) => Array.isArray(e.nonRolling) && e.nonRolling.length);
  console.log(`rows carrying a non-rolling group: ${withGroup.length}`);
  if (withGroup.length) {
    // Anybody who was being PAID through the group loses that share. Named
    // rather than counted: this is the one thing in the migration that takes
    // money away from a person rather than moving a number.
    const lost = new Map();
    for (const e of withGroup) {
      for (const m of e.nonRolling) {
        if (m.present === false) continue;
        const k = m.name || String(m.employee);
        lost.set(k, r2((lost.get(k) || 0) + (e.perNonRollingPoints || 0)));
      }
    }
    console.log('  these people STOP earning a non-rolling share:');
    for (const [name, pts] of lost) console.log(`    ${name}: ${pts} points`);
  }

  let changed = 0;
  let grossWas = 0;
  let grossNow = 0;
  const sample = [];

  for (const e of raw) {
    const before = r2(e.teamPoints);
    // The frozen per-day figure, under whichever name it is stored.
    const pct = e.deductionPct == null ? e.nonRollingSharePct : e.deductionPct;
    const doc = {
      sheets: e.sheets,
      pointsPerSheet: e.pointsPerSheet,
      rupeePerPoint: e.rupeePerPoint,
      deductionPct: pct == null ? 30 : pct,
      members: e.members || [],
      picker: e.picker,
    };
    recalc(doc);

    grossWas += before;
    grossNow += doc.teamPoints;
    if (sample.length < 8) {
      sample.push(`  ${ymd(e.date)} ${String(e.teamName || '').padEnd(12)} `
        + `sheets ${String(e.sheets ?? '—').padStart(4)}  `
        + `${String(before).padStart(8)} -> ${String(doc.teamPoints).padStart(8)} `
        + `(gross ${doc.grossPoints}, less ${doc.deductionPoints} at ${doc.deductionPct}%)`);
    }

    if (APPLY) {
      await mongoose.connection.db.collection('incentiveentries').updateOne(
        { _id: e._id },
        {
          $set: {
            deductionPct: doc.deductionPct,
            grossPoints: doc.grossPoints,
            deductionPoints: doc.deductionPoints,
            teamPoints: doc.teamPoints,
            perPersonPoints: doc.perPersonPoints,
            totalAmount: doc.totalAmount,
            perPersonAmount: doc.perPersonAmount,
            headCount: doc.headCount,
          },
          $unset: {
            nonRolling: '',
            nonRollingSharePct: '',
            nonRollingPoints: '',
            rollingPoints: '',
            nonRollingHeadCount: '',
            perNonRollingPoints: '',
          },
        },
      );
    }
    changed += 1;
  }

  console.log('\nper-day restatement (first few):');
  sample.forEach((l) => console.log(l));
  console.log(`\nrows ${APPLY ? 'updated' : 'that would be updated'}: ${changed}`);
  console.log(`team points in total: ${r2(grossWas)} -> ${r2(grossNow)}`);

  // The company setting, if a value ever made it past strict mode.
  const s = await Setting.findOne({});
  const legacy = s?.incentive?.nonRollingSharePct;
  if (legacy != null) {
    console.log(`\nSetting.incentive.nonRollingSharePct = ${legacy} -> deductionPct`);
    if (APPLY) {
      await Setting.updateOne({ _id: s._id }, {
        $set: { 'incentive.deductionPct': legacy },
        $unset: { 'incentive.nonRollingSharePct': '' },
      });
    }
  } else {
    console.log('\nSetting.incentive.nonRollingSharePct: not set (the default 30 applies)');
  }

  if (APPLY) {
    // What the roll-ups will now report, read back through the real model so
    // this is the same path every screen takes rather than a second sum.
    const after = await IncentiveEntry.find({}).lean();
    const byPerson = new Map();
    for (const e of after) {
      for (const p of payees(e)) {
        const k = p.name || String(p.employee);
        byPerson.set(k, r2((byPerson.get(k) || 0) + (p.sharePoints || 0)));
      }
    }
    console.log('\nearned per person, as the portal will now report it:');
    for (const [name, pts] of [...byPerson].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(name).padEnd(24)} ${String(pts).padStart(9)}`);
    }
  }

  console.log(APPLY ? '\nDone.' : '\nDry run only — re-run with --apply to write.\n');
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
