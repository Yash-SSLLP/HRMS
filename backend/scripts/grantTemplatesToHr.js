/**
 * Give every HR Manager the Admin → Email & Letter Templates page.
 *
 * The page has two tabs and each answers to its own capability:
 *   templates.manage → "Templates"          (what every mail and letter SAYS)
 *   branding.manage  → "Logo & signatures"  (the letterhead stamped on them)
 *
 * Both are grantable per account from the web Permissions page; this is the bulk
 * form of ticking them, for when the answer is "all of HR" rather than one
 * person. It touches ONLY HRManager accounts with a restricted `permissions`
 * array — an HR whose array is absent already holds every capability (the
 * migration default; see config/permissions.js), so there is nothing to add.
 *
 * Deliberately a data change and not a role default: a Super Admin who unticks
 * one of these later must stay untucked, which a hard-coded role rule would
 * quietly override.
 *
 * Run (from backend/):
 *   node scripts/grantTemplatesToHr.js          # report only
 *   node scripts/grantTemplatesToHr.js --apply  # actually grant
 *
 * Safe to re-run: an account that already holds a key is left alone.
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const User = require('../models/User');

const KEYS = ['templates.manage', 'branding.manage'];
const APPLY = process.argv.includes('--apply');

(async () => {
  try {
    await connectDB();
    const hrs = await User.find({ role: 'HRManager' }).select('email permissions isActive');

    let granted = 0;
    let alreadyAll = 0;
    let alreadyHeld = 0;
    for (const hr of hrs) {
      if (hr.permissions == null) { // undefined/null => ALL capabilities
        alreadyAll += 1;
        console.log(`  skip   ${hr.email} — holds every capability already`);
        continue;
      }
      const missing = KEYS.filter((k) => !hr.permissions.includes(k));
      if (!missing.length) {
        alreadyHeld += 1;
        console.log(`  ok     ${hr.email} — already has both tabs`);
        continue;
      }
      console.log(`  ${APPLY ? 'grant ' : 'would '} ${hr.email} += ${missing.join(', ')}`);
      if (APPLY) {
        hr.permissions.push(...missing);
        await hr.save();
      }
      granted += 1;
    }

    console.log(`\n${hrs.length} HR Manager account(s): ${granted} ${APPLY ? 'granted' : 'to grant'}, `
      + `${alreadyHeld} already held, ${alreadyAll} unrestricted.`);
    if (!APPLY && granted) console.log('Re-run with --apply to make the change.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
