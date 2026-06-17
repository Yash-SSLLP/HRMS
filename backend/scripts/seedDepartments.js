// Seed the starting set of departments. SuperAdmin can add more from the UI.
// Usage: node scripts/seedDepartments.js   (or: npm run seed:departments)
require('dotenv').config();
const connectDB = require('../config/db');
const Department = require('../models/Department');

const DEPARTMENTS = ['IT', 'Account', 'Sales', 'Billing', 'Dispatch', 'Showroom', 'Boys'];

(async () => {
  try {
    await connectDB();
    let created = 0;
    let skipped = 0;
    for (const name of DEPARTMENTS) {
      const exists = await Department.findOne({ name });
      if (exists) {
        skipped += 1;
        continue;
      }
      await Department.create({ name });
      created += 1;
    }
    console.log(`Departments seeded — created: ${created}, skipped (already present): ${skipped}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
