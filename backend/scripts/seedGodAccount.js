/**
 * Create (or reset) the God account — the portal's permanently view-only login.
 *
 * What it is: one account that can READ the whole admin portal for the
 * companies a Super Admin ticks for it, and can change nothing at all. Unlike a
 * CEO/MD there is no edit mode to switch on later; the refusal lives in
 * `protect` (middleware/authMiddleware.js), so every route in the app — including
 * ones written after this — is covered without being gated individually.
 *
 * It is NOT a member of staff: no employee profile, no attendance, no payroll,
 * and it is hidden from every people listing a non-Super-Admin can see.
 *
 * Sign in with "God" (the identifier is case- and space-insensitive; the login
 * email below works too).
 *
 * Run (from backend/):
 *   node scripts/seedGodAccount.js
 *
 * Safe to re-run: the account is looked up by ROLE, so running it twice resets
 * the one account rather than creating a second. Every run ends in a known
 * state — correct role, active, and the seed password — so a forgotten password
 * is one command away from being usable again. Resetting the password bumps
 * tokenVersion (the pre-save hook), which signs the account out everywhere.
 *
 * Override the details via env:
 *   SEED_GOD_EMAIL, SEED_GOD_PASSWORD, SEED_GOD_FIRST, SEED_GOD_LAST
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const User = require('../models/User');

const SEED = {
  email: (process.env.SEED_GOD_EMAIL || 'god@sequencesurface.com').toLowerCase(),
  password: process.env.SEED_GOD_PASSWORD || 'thisisgod',
  firstName: process.env.SEED_GOD_FIRST || 'God',
  lastName: process.env.SEED_GOD_LAST || 'View',
  role: 'God',
};

(async () => {
  try {
    await connectDB();

    // By role, not by email: the login identifier is "God" (see
    // utils/loginIdentity ROLE_ALIASES), and that alias resolves to the single
    // active account holding the role. Matching on the address instead would
    // let a changed SEED_GOD_EMAIL quietly create a SECOND God account, which
    // makes the alias ambiguous and locks both of them out.
    let god = await User.findOne({ role: 'God' }).select('+password');
    if (god) {
      god.email = SEED.email;
      god.firstName = SEED.firstName;
      god.lastName = SEED.lastName;
      god.isActive = true;
      // An admin-set password is normally a way back IN, not a password to
      // keep, so `mustChangePassword` would be the usual companion. Not here:
      // this account is shared and view-only by design, and changing its own
      // password is itself a write the account is not allowed to make — it
      // would be held on the change-password screen forever.
      god.mustChangePassword = false;
      god.password = SEED.password; // pre-save hook re-hashes and bumps tokenVersion
      await god.save();
      console.log(`Reset the God account: ${god.email}`);
    } else {
      god = await User.create(SEED);
      console.log(`Created the God account: ${god.email}`);
    }

    const scoped = Array.isArray(god.companies) ? god.companies.length : 0;
    console.log(`  Sign in as : God   (password: ${SEED.password})`);
    console.log(`  Access     : view-only, ${scoped ? `${scoped} assigned compan${scoped === 1 ? 'y' : 'ies'}` : 'every company'}`);
    console.log('  Companies  : set them on the web Permissions page (Company access column).');
    console.log('\nWARNING: change this password from the Permissions page before real use.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
