/**
 * Close the editing window on every expense recorded BEFORE it existed.
 *
 *   node scripts/confirmLegacyExpenses.js          # report what it would do
 *   node scripts/confirmLegacyExpenses.js --apply  # actually do it
 *
 * WHY THIS IS NEEDED. An expense now stays correctable — by the employee who
 * filed it and by the company — until somebody on the company side CONFIRMS it
 * (KhataEntry.confirmedByCompany). Rows written before that flag existed carry
 * no value for it, which reads as "never confirmed", which would mean:
 *
 *   - every expense in the company's history reappears in the accounts team's
 *     "expenses to confirm" queue, months of them at once; and
 *   - every employee could go back and rewrite the amount on spending from last
 *     quarter, which is the one thing the window is deliberately narrow to
 *     prevent.
 *
 * Neither is what anybody intends by turning the feature on. Those rows were
 * settled under the old rules — recorded, reviewed by being left to stand, and
 * closed — so this stamps them as confirmed, which is what they effectively
 * already were.
 *
 * `confirmedBy` is deliberately left NULL: nobody actually pressed a button on
 * these, and inventing an approver would put a name against a decision that was
 * never made. A null confirmer with a confirmation date reads correctly as
 * "closed by the migration".
 *
 * RUN THIS ONCE, when deploying the confirm/edit change. Safe to run again: it
 * only ever touches rows that still have no value for the flag.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const KhataEntry = require('../models/KhataEntry');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

// Only spending. Advances, settlements and reimbursements have their own
// approval path and never carried this flag in the first place.
const filter = { type: 'expense', confirmedByCompany: { $ne: true } };

async function run() {
  await connectDB();

  const count = await KhataEntry.countDocuments(filter);
  if (!count) {
    say('every expense is already confirmed — nothing to do.');
    return;
  }

  const oldest = await KhataEntry.findOne(filter).sort({ date: 1 }).select('date code');
  const newest = await KhataEntry.findOne(filter).sort({ date: -1 }).select('date code');
  say(`${count} expense${count === 1 ? '' : 's'} would be marked confirmed `
    + `(${oldest?.date?.toDateString()} → ${newest?.date?.toDateString()}).`);

  if (!APPLY) {
    console.log('\nRe-run with --apply to write the change.');
    return;
  }

  const res = await KhataEntry.updateMany(filter, {
    $set: { confirmedByCompany: true, confirmedAt: new Date(), confirmedBy: null },
  });
  say(`marked ${res.modifiedCount} expense${res.modifiedCount === 1 ? '' : 's'} as confirmed.`);
  console.log('Anything recorded from now on stays editable until somebody confirms it.');
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
