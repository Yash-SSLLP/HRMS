// Seed the first SuperAdmin so the admin UI is usable.
// Usage: node scripts/seedSuperAdmin.js
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');

const SEED = {
  email: process.env.SEED_ADMIN_EMAIL || 'admin@ss.com',
  password: process.env.SEED_ADMIN_PASSWORD || '123',
  firstName: 'Sample',
  lastName: 'Admin',
  role: 'SuperAdmin',
};

(async () => {
  try {
    await connectDB();
    const existing = await User.findOne({ email: SEED.email.toLowerCase() });
    if (existing) {
      console.log(`SuperAdmin already exists: ${existing.email}`);
      process.exit(0);
    }
    const user = await User.create(SEED);
    console.log(`Created SuperAdmin: ${user.email} (password: ${SEED.password})`);
    console.log('WARNING: Sample credentials. Change this password before any real use.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
