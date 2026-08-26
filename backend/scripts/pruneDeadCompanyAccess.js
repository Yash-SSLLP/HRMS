/**
 * Remove company ids from User.companies that no longer point at a company.
 *
 *   node scripts/pruneDeadCompanyAccess.js          # report what it would do
 *   node scripts/pruneDeadCompanyAccess.js --apply  # actually do it
 *
 * WHY THESE EXIST. `deleteCompany` used to remove the Company document without
 * touching the execs who had been granted access to it, so every company ever
 * deleted left its id behind in `User.companies`.
 *
 * WHY THEY ARE NOT COSMETIC. That array is not a display list — it is the access
 * scope (utils/employeeScope.js):
 *
 *     []            -> every company        (unrestricted)
 *     [a, b]        -> only companies a & b (restricted)
 *
 * A dead id keeps the array non-empty, so the exec stays in company-limited mode
 * with one of their "companies" matching nothing. Every employee whose profile
 * has no company, or a company outside the surviving list, becomes invisible to
 * them — a CEO who should see everyone sees a fraction, and nothing anywhere
 * reports an error.
 *
 * It cannot be fixed from the Permissions screen either: that modal can only draw
 * checkboxes for companies that still exist, so the phantom is invisible there,
 * the footer reads "2 selected" beside a single tick, and saving posts the whole
 * set — writing the phantom straight back.
 *
 * Safe to run more than once. The leak itself is closed in
 * controllers/companyController.js; this clears what the old behaviour left.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Company = require('../models/Company');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

async function run() {
  await connectDB();

  const live = new Set((await Company.find().select('_id').lean()).map((c) => String(c._id)));
  console.log(`\n${live.size} company(ies) exist.\n`);

  // Only users that carry at least one id — a user with [] is already
  // unrestricted and must stay that way.
  const users = await User.find({ 'companies.0': { $exists: true } })
    .select('firstName lastName email role companies')
    .lean();

  let affected = 0;

  for (const u of users) {
    const ids = (u.companies || []).map(String);
    const dead = ids.filter((id) => !live.has(id));
    if (!dead.length) continue;

    affected += 1;
    const keep = ids.filter((id) => live.has(id));
    const who = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;

    console.log(`  ${who} (${u.role})`);
    console.log(`      holds  ${ids.length}: ${dead.length} dead — ${dead.join(', ')}`);
    console.log(`      after  ${keep.length}: ${keep.length ? keep.join(', ') : 'EMPTY → unrestricted, sees every company'}`);

    if (APPLY) {
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne({ _id: u._id }, { $set: { companies: keep } });
    }
  }

  if (!affected) {
    console.log('Nothing to prune — every granted company id points at a company that exists.\n');
  } else {
    say(`\n${affected} user(s) ${APPLY ? 'cleaned' : 'would be cleaned'}.`);
    if (!APPLY) console.log('\nRe-run with --apply to write these changes.\n');
    else console.log('\nDone. Anyone whose list is now EMPTY can see every company again.\n');
  }

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(`\n${err.message}\n`);
  await mongoose.disconnect().catch(() => {});
  process.exitCode = 1;
});
