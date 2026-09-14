/**
 * READ-ONLY: everything the khata module holds for the given employee codes.
 * Writes nothing. Run:
 *
 *   node scripts/khataInventory.js "SSL 36" "SSL 120"
 */
require('dotenv').config();
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const EmployeeWallet = require('../models/EmployeeWallet');
const EmployeeKhata = require('../models/EmployeeKhata');
const KhataEntry = require('../models/KhataEntry');
require('../models/User');

const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
const money = (n) => `₹${new Intl.NumberFormat('en-IN').format(Number(n) || 0)}`;

(async () => {
  await connectDB();
  const codes = process.argv.slice(2);
  if (!codes.length) throw new Error('Pass one or more employee codes.');

  const all = await EmployeeProfile.find({}, 'employeeCode user designation department').lean();

  for (const code of codes) {
    const p = all.find((x) => loose(x.employeeCode) === loose(code));
    if (!p) { console.log(`\n### ${code} — NO SUCH EMPLOYEE`); continue; }

    const prof = await EmployeeProfile.findById(p._id).populate('user', 'fullName firstName lastName email').lean();
    const uid = prof.user._id;
    const name = prof.user.fullName || [prof.user.firstName, prof.user.lastName].filter(Boolean).join(' ');
    console.log(`\n### ${prof.employeeCode} — ${name}  (user ${uid})`);
    console.log(`    ${prof.designation || '-'} · ${prof.department || '-'}`);

    const wallet = await EmployeeWallet.findOne({ employee: uid }).lean();
    console.log(`  wallet : ${wallet ? `yes (balance ${money(wallet.balance)})` : 'none'}`);

    const khatas = await EmployeeKhata.find({ employee: uid }).lean();
    console.log(`  books  : ${khatas.length}`);
    for (const k of khatas) {
      const n = await KhataEntry.countDocuments({ khata: k._id });
      console.log(`      · "${k.name}"  balance ${money(k.balance)}  status ${k.status || '-'}  entries ${n}`
        + `${(k.members || []).length ? `  members ${k.members.length}` : ''}`);
    }

    const entries = await KhataEntry.find({ employee: uid }).lean();
    const withFiles = entries.filter((e) => (e.attachments || []).length);
    const linked = entries.filter((e) => e.cashbookEntry);
    const files = withFiles.reduce((a, e) => a + e.attachments.length, 0);
    console.log(`  entries: ${entries.length} total`);
    console.log(`      with bill attachments : ${withFiles.length} entries / ${files} files`);
    console.log(`      linked to a CASHBOOK entry : ${linked.length}`);
    if (linked.length) {
      linked.slice(0, 10).forEach((e) => console.log(`        ! ${e.code || e._id} ${money(e.amount)} -> cashbook ${e.cashbookEntry}`));
    }
    const byDir = entries.reduce((a, e) => { a[e.direction] = (a[e.direction] || 0) + 1; return a; }, {});
    console.log(`      by direction: ${JSON.stringify(byDir)}`);
    if (entries.length) {
      const dates = entries.map((e) => new Date(e.date || e.createdAt)).sort((a, b) => a - b);
      console.log(`      dated ${dates[0].toISOString().slice(0, 10)} .. ${dates[dates.length - 1].toISOString().slice(0, 10)}`);
    }
  }

  // What the module holds in total, so the blast radius is visible.
  console.log('\n--- module totals (all employees) ---');
  console.log('  wallets:', await EmployeeWallet.countDocuments({}));
  console.log('  books  :', await EmployeeKhata.countDocuments({}));
  console.log('  entries:', await KhataEntry.countDocuments({}));

  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
