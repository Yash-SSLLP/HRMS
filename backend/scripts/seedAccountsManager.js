// Set up the Cashbook module's access:
//   1) Create an "Account Manager" (AccountsManager) user — a cashbook-only admin.
//   2) Grant 'cashbook.manage' to every HRManager who has a RESTRICTED permissions
//      array (HRs with no array already hold all permissions).
// Idempotent — safe to run more than once.
//
// Usage: node scripts/seedAccountsManager.js   (or: npm run seed:accounts-manager)
// Override the Account Manager via env:
//   SEED_ACCOUNTS_EMAIL, SEED_ACCOUNTS_PASSWORD, SEED_ACCOUNTS_FIRST, SEED_ACCOUNTS_LAST
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');
const { ensureEmployeeProfile } = require('../services/ensureProfile');

const SEED = {
  email: (process.env.SEED_ACCOUNTS_EMAIL || 'accounts@sequencesurface.com').toLowerCase(),
  password: process.env.SEED_ACCOUNTS_PASSWORD || 'Welcome@123',
  firstName: process.env.SEED_ACCOUNTS_FIRST || 'Accounts',
  lastName: process.env.SEED_ACCOUNTS_LAST || 'Manager',
  role: 'AccountsManager',
};

(async () => {
  try {
    await connectDB();

    // 1) Account Manager user
    let am = await User.findOne({ email: SEED.email });
    if (am) {
      if (am.role !== 'AccountsManager') {
        am.role = 'AccountsManager';
        await am.save();
        console.log(`1) Updated ${SEED.email} -> role AccountsManager`);
      } else {
        console.log(`1) Account Manager already exists: ${SEED.email} (no change)`);
      }
    } else {
      am = await User.create(SEED);
      console.log(`1) Created Account Manager: ${am.email} (password: ${SEED.password})`);
      console.log('   WARNING: sample password — change it before any real use.');
    }
    try { await ensureEmployeeProfile(am); } catch (err) { console.error('   (profile create skipped:', err.message, ')'); }

    // 2) Grant cashbook.manage to restricted HRManagers
    const hrs = await User.find({ role: 'HRManager' });
    let granted = 0, alreadyAll = 0;
    for (const hr of hrs) {
      if (hr.permissions == null) { alreadyAll += 1; continue; } // undefined => ALL
      if (!hr.permissions.includes('cashbook.manage')) {
        hr.permissions.push('cashbook.manage');
        await hr.save();
        granted += 1;
        console.log(`2) Granted cashbook.manage -> ${hr.email}`);
      }
    }
    console.log(`2) HRManagers: ${granted} newly granted, ${alreadyAll} already have ALL, ${hrs.length} total.`);

    console.log('\nDone. The Account Manager can log in and will see only the Cashbook page.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
