/**
 * Apply the import's name-capitalisation rules to accounts ALREADY in the
 * database.
 *
 *   node scripts/tidyEmployeeNames.js            # dry run — lists, changes nothing
 *   node scripts/tidyEmployeeNames.js --apply    # actually rename
 *
 * The Excel import now tidies "YASH KUMAR" / "yash kumar" into "Yash Kumar" as
 * the sheet is read (services/employeeExcel.js → parsePersonName). Everyone
 * imported BEFORE that kept whatever the spreadsheet shouted, which is why the
 * directory reads as a mix of cases. This runs the very same function over the
 * stored names so old and new records agree.
 *
 * It reuses parsePersonName rather than reimplementing it — the whole point is
 * that there is one rule, and the protection for deliberately mixed-case names
 * ("McDonald", "D'Souza") comes along with it.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const { parsePersonName } = require('../services/employeeExcel');

const APPLY = process.argv.includes('--apply');

async function run() {
  await connectDB();

  const users = await User.find({}).select('firstName lastName email role').sort({ email: 1 });
  const changes = [];
  for (const u of users) {
    const first = parsePersonName(u.firstName) ?? u.firstName;
    const last = parsePersonName(u.lastName) ?? u.lastName;
    if (first !== u.firstName || last !== u.lastName) {
      changes.push({
        doc: u,
        from: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
        to: `${first || ''} ${last || ''}`.trim(),
        first,
        last,
      });
    }
  }

  console.log(`\n${users.length} accounts checked, ${changes.length} would change.\n`);
  if (!changes.length) {
    console.log('Every name is already tidy.\n');
    await mongoose.disconnect();
    return;
  }
  changes.forEach((c) => console.log(`  ${c.from.padEnd(28)} →  ${c.to.padEnd(28)} ${c.doc.email}`));

  if (!APPLY) {
    console.log('\n[dry run] nothing was changed. To go ahead:\n'
      + '    node scripts/tidyEmployeeNames.js --apply\n');
    await mongoose.disconnect();
    return;
  }

  for (const c of changes) {
    // updateOne rather than save(): nothing else on the document should move,
    // and a full save would re-run hooks that have no business firing for a
    // capitalisation fix.
    // eslint-disable-next-line no-await-in-loop
    await User.updateOne({ _id: c.doc._id }, { firstName: c.first, lastName: c.last });
  }
  console.log(`\nRenamed ${changes.length} account(s).\n`);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
