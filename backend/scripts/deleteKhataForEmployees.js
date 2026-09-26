/**
 * Remove one or more employees' khatabook data — the wallet, the expense books
 * and any entries under them.
 *
 * DRY RUN unless --apply is passed. Every document is written to a JSON backup
 * before anything is removed, so a mistake is recoverable.
 *
 *   node scripts/deleteKhataForEmployees.js "SSL 36" "SSL 120"
 *   node scripts/deleteKhataForEmployees.js "SSL 36" "SSL 120" --apply
 *
 * SCOPE, deliberately narrow: the three khata collections and the stored bill
 * files hanging off their entries. It does NOT touch the cashbook — a cash
 * ledger entry is the company's own record of money that actually moved, and it
 * outlives whatever expense prompted it.
 *
 * A wallet and a default "General" book are auto-provisioned the first time
 * somebody opens their khata, so removing these is not permanent in the sense of
 * locking anyone out: the person simply starts again from empty.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const EmployeeWallet = require('../models/EmployeeWallet');
const EmployeeKhata = require('../models/EmployeeKhata');
const KhataEntry = require('../models/KhataEntry');
const storage = require('../services/storage');
require('../models/User');

const APPLY = process.argv.includes('--apply');
const CODES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'khata-backups');

const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
const money = (n) => `₹${new Intl.NumberFormat('en-IN').format(Number(n) || 0)}`;

(async () => {
  await connectDB();
  if (!CODES.length) throw new Error('Pass at least one employee code.');
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — khata removal for: ${CODES.join(', ')}\n`);

  const all = await EmployeeProfile.find({}, 'employeeCode user').lean();
  const targets = [];
  for (const code of CODES) {
    const p = all.find((x) => loose(x.employeeCode) === loose(code));
    if (!p) throw new Error(`No employee with code "${code}" — nothing was changed.`);
    const prof = await EmployeeProfile.findById(p._id).populate('user', 'fullName firstName lastName email').lean();
    targets.push({
      code: prof.employeeCode,
      userId: prof.user._id,
      name: prof.user.fullName || [prof.user.firstName, prof.user.lastName].filter(Boolean).join(' '),
      email: prof.user.email,
    });
  }
  const ids = targets.map((t) => t.userId);

  const wallets = await EmployeeWallet.find({ employee: { $in: ids } }).lean();
  const books = await EmployeeKhata.find({ employee: { $in: ids } }).lean();
  const entries = await KhataEntry.find({ employee: { $in: ids } }).lean();

  // A book shared with somebody NOT being removed would take their access with
  // it. Name them rather than discovering it afterwards.
  const outsiders = [];
  for (const b of books) {
    for (const m of b.members || []) {
      if (!ids.some((i) => String(i) === String(m.user))) outsiders.push({ book: b.name, member: String(m.user) });
    }
  }

  for (const t of targets) {
    const w = wallets.find((x) => String(x.employee) === String(t.userId));
    const bs = books.filter((x) => String(x.employee) === String(t.userId));
    const es = entries.filter((x) => String(x.employee) === String(t.userId));
    console.log(`${t.code} — ${t.name} <${t.email}>`);
    console.log(`    wallet  : ${w ? money(w.balance) : 'none'}`);
    console.log(`    books   : ${bs.length}${bs.length ? ` — ${bs.map((b) => `"${b.name}" (spent ${money(b.spent)}, entryCount ${b.entryCount})`).join(', ')}` : ''}`);
    console.log(`    entries : ${es.length}`);
  }

  if (outsiders.length) {
    console.log('\n  ! books shared with someone NOT in this list (their access goes too):');
    outsiders.forEach((o) => console.log(`      "${o.book}" -> user ${o.member}`));
  } else if (books.some((b) => (b.members || []).length)) {
    console.log('\n  shared books are shared only between the people being removed — nobody else loses access.');
  }

  const files = entries.flatMap((e) => (e.attachments || []).map((a) => a.storagePath).filter(Boolean));
  console.log(`\n  bill files to remove: ${files.length}`);

  // ------------------------------------------------------------- backup ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `khata-${CODES.map(loose).join('_')}-${stamp}.json`);
  console.log(`\n  ${APPLY ? '[done]' : '[would]'} back up ${wallets.length} wallet(s), ${books.length} book(s), ${entries.length} entr(ies) -> ${backup}`);
  if (APPLY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.writeFileSync(backup, JSON.stringify({ takenAt: new Date(), targets, wallets, books, entries }, null, 2));
  }

  // ------------------------------------------------------------- delete ----
  console.log(`  ${APPLY ? '[done]' : '[would]'} delete ${entries.length} entr(ies), ${books.length} book(s), ${wallets.length} wallet(s)`);
  if (APPLY) {
    for (const p of files) {
      try { await storage.remove(p); } catch (e) { console.error('    bill file:', e.message); }
    }
    const e1 = await KhataEntry.deleteMany({ employee: { $in: ids } });
    const e2 = await EmployeeKhata.deleteMany({ employee: { $in: ids } });
    const e3 = await EmployeeWallet.deleteMany({ employee: { $in: ids } });
    console.log(`    removed: entries ${e1.deletedCount}, books ${e2.deletedCount}, wallets ${e3.deletedCount}`);
  }

  console.log(APPLY ? '\nDone.' : '\nDry run only — re-run with --apply to delete.');
  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
