/**
 * Remove one or more employees' khatabook data — the wallet, the expense books
 * and every ledger row of theirs — or, with --entries-only, just the rows.
 *
 * DRY RUN unless --apply is passed. Every document, and every bill file the rows
 * carry, is written to a backup before anything is removed, so a mistake is
 * recoverable.
 *
 *   node scripts/deleteKhataForEmployees.js "SSL 36" "SSL 120"
 *   node scripts/deleteKhataForEmployees.js "SSL 36" "SSL 120" --apply
 *   node scripts/deleteKhataForEmployees.js "SSL 36" --entries-only --include-cash --apply
 *
 * FIXED 2026-09-26. This used to read and delete entries through the legacy
 * `models/KhataEntry` — an EMPTY collection since the khata merged into the
 * cashbook (2026-08-24) — and looked for bills under `attachments[]`, while a
 * live row carries one `attachment`. So a run on 2026-09-12 (SSL 36, SSL 120)
 * removed the two wallets and nine books and deleted no entries at all: the rows
 * stayed in the cashbook collection pointing at books that no longer existed,
 * and still showed on the people's statements. Entries now go through the live
 * ledger (CashbookEntry.EmployeeLedgerEntry).
 *
 * MODES
 *   (default)       the wallet, the books and every row of the people named.
 *   --entries-only  the rows (and their bills) only; the current wallet and
 *                   books stay, and are re-counted afterwards so their stored
 *                   figures match what is left. For finishing a wipe the old
 *                   version of this script left half done, without taking a
 *                   book the person has opened since.
 *
 * ROWS THAT MOVED COMPANY CASH ARE REFUSED unless --include-cash is passed.
 * Since the merge a person's advance IS the cash account's own row, not a copy
 * of it: removing it changes that account's balance by the amount, and the dry
 * run prints by how much. With --include-cash they are removed and every
 * account touched is re-counted from what remains.
 *
 * Somebody ELSE's rows filed under a book being removed are listed and left
 * alone — that is their money, spent out of their own wallet.
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
const CashbookEntry = require('../models/CashbookEntry');
const { POSTED_STATUSES } = require('../models/CashbookEntry');
const CashAccount = require('../models/CashAccount');
const storage = require('../services/storage');
const ledger = require('../services/khataLedger');
require('../models/User');

// The LIVE employee ledger — never models/KhataEntry, which is empty.
const Entry = CashbookEntry.EmployeeLedgerEntry;

const APPLY = process.argv.includes('--apply');
const ENTRIES_ONLY = process.argv.includes('--entries-only');
const INCLUDE_CASH = process.argv.includes('--include-cash');
const CODES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'khata-backups');

const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
const money = (n) => `${Number(n) < 0 ? '-' : ''}₹${new Intl.NumberFormat('en-IN').format(Math.abs(Number(n) || 0))}`;
const billsOf = (e) => [e.attachment?.storagePath, ...(e.attachments || []).map((a) => a.storagePath)].filter(Boolean);
const safeName = (s) => String(s || 'bill').replace(/[^\w.\-]+/g, '_').slice(0, 80);

(async () => {
  await connectDB();
  if (!CODES.length) throw new Error('Pass at least one employee code.');
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — khata removal (${ENTRIES_ONLY ? 'rows only' : 'wallet, books and rows'}) for: ${CODES.join(', ')}\n`);

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
  const entries = await Entry.find({ employee: { $in: ids } }).lean();
  const entryIds = entries.map((e) => e._id);

  for (const t of targets) {
    const w = wallets.find((x) => String(x.employee) === String(t.userId));
    const bs = books.filter((x) => String(x.employee) === String(t.userId));
    const es = entries.filter((x) => String(x.employee) === String(t.userId));
    console.log(`${t.code} — ${t.name} <${t.email}>`);
    console.log(`    wallet  : ${w ? money(w.balance) : 'none'}${ENTRIES_ONLY ? '  (kept)' : ''}`);
    console.log(`    books   : ${bs.length}${bs.length ? ` — ${bs.map((b) => `"${b.name}" (spent ${money(b.spent)}, entryCount ${b.entryCount})`).join(', ')}` : ''}${ENTRIES_ONLY ? '  (kept)' : ''}`);
    console.log(`    entries : ${es.length}${es.length ? ` — ${es.map((e) => `${e.code || e._id} ${e.movement} ${e.status} ${money(e.amount)}`).join(', ')}` : ''}`);
  }

  // A book shared with somebody NOT being removed would take their access with
  // it, and their rows filed under it would lose their heading. Name both.
  if (!ENTRIES_ONLY) {
    const outsiders = [];
    for (const b of books) {
      for (const m of b.members || []) {
        if (!ids.some((i) => String(i) === String(m.user))) outsiders.push({ book: b.name, member: String(m.user) });
      }
    }
    if (outsiders.length) {
      console.log('\n  ! books shared with someone NOT in this list (their access goes too):');
      outsiders.forEach((o) => console.log(`      "${o.book}" -> user ${o.member}`));
    }
    const othersRows = await Entry.countDocuments({ expenseBook: { $in: books.map((b) => b._id) }, employee: { $nin: ids } });
    if (othersRows) {
      console.log(`\n  ! ${othersRows} row(s) of OTHER people are filed under these books. They are left alone`
        + ' (their own money) and lose the book\'s name.');
    }
  }

  // Rows that moved company cash: the account's own movements since the merge.
  const cashRows = entries.filter((e) => e.account);
  const accountIds = [...new Set(cashRows.map((e) => String(e.account)))];
  if (cashRows.length) {
    console.log(`\n  ${INCLUDE_CASH ? '' : '! '}${cashRows.length} row(s) moved COMPANY CASH:`);
    for (const id of accountIds) {
      const acc = await CashAccount.findById(id).select('name currentBalance openingBalance').lean();
      const mine = cashRows.filter((e) => String(e.account) === id);
      const rest = await CashbookEntry.find({ account: id, status: { $in: POSTED_STATUSES }, _id: { $nin: entryIds } })
        .select('type amount').lean();
      const after = ledger.round2((acc?.openingBalance || 0)
        + rest.reduce((s, e) => s + (e.type === 'in' ? e.amount : -e.amount), 0));
      console.log(`      account "${acc?.name || id}": ${mine.map((e) => `${e.code} ${e.movement} ${e.type} ${money(e.amount)}`).join(', ')}`);
      console.log(`        balance ${money(acc?.currentBalance)} -> ${money(after)} once they are gone`);
    }
    if (!INCLUDE_CASH) {
      console.log('      Refused without --include-cash: removing them changes those balances.');
      if (APPLY) throw new Error('Rows that moved company cash need --include-cash. Nothing was changed.');
    }
  }

  const files = entries.flatMap((e) => billsOf(e).map((p) => ({ entry: e, path: p })));
  console.log(`\n  bill files to remove: ${files.length}`);

  // ------------------------------------------------------------- backup ----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(BACKUP_DIR, `khata-${CODES.map(loose).join('_')}-${ENTRIES_ONLY ? 'rows-' : ''}${stamp}`);
  console.log(`\n  ${APPLY ? '[done]' : '[would]'} back up ${ENTRIES_ONLY ? '' : `${wallets.length} wallet(s), ${books.length} book(s), `}`
    + `${entries.length} entr(ies) -> ${base}.json, and ${files.length} bill file(s) -> ${base}-bills/`);
  if (APPLY) {
    fs.mkdirSync(`${base}-bills`, { recursive: true });
    const billIndex = [];
    for (const f of files) {
      try {
        const buf = await storage.readBuffer(f.path);
        const out = `${f.entry._id}-${safeName(f.entry.attachment?.name || path.basename(f.path))}`;
        fs.writeFileSync(path.join(`${base}-bills`, out), buf);
        billIndex.push({ entry: f.entry._id, storagePath: f.path, file: out, bytes: buf.length });
      } catch (e) {
        billIndex.push({ entry: f.entry._id, storagePath: f.path, missing: e.message });
        console.error(`    bill ${f.path}: ${e.message} (not backed up)`);
      }
    }
    fs.writeFileSync(`${base}.json`, JSON.stringify({
      takenAt: new Date(),
      mode: ENTRIES_ONLY ? 'entries-only' : 'full',
      targets,
      wallets: ENTRIES_ONLY ? [] : wallets,
      books: ENTRIES_ONLY ? [] : books,
      entries,
      bills: billIndex,
    }, null, 2));
  }

  // ------------------------------------------------------------- delete ----
  console.log(`  ${APPLY ? '[done]' : '[would]'} delete ${entries.length} entr(ies)`
    + `${ENTRIES_ONLY ? '' : `, ${books.length} book(s), ${wallets.length} wallet(s)`}`);
  if (APPLY) {
    for (const f of files) {
      try { await storage.remove(f.path); } catch (e) { console.error('    bill file:', e.message); }
    }
    const e1 = await Entry.deleteMany({ _id: { $in: entryIds } });
    let removed = `entries ${e1.deletedCount}`;
    if (!ENTRIES_ONLY) {
      const e2 = await EmployeeKhata.deleteMany({ employee: { $in: ids } });
      const e3 = await EmployeeWallet.deleteMany({ employee: { $in: ids } });
      removed += `, books ${e2.deletedCount}, wallets ${e3.deletedCount}`;
    }
    console.log(`    removed: ${removed}`);

    // Re-count what is left, so no stored figure goes on describing the rows
    // that are gone.
    for (const id of accountIds) {
      const bal = await ledger.recomputeCashAccount(id);
      console.log(`    account ${id}: balance now ${money(bal)}`);
    }
    if (ENTRIES_ONLY) {
      for (const t of targets) {
        const bal = await ledger.recomputeWalletBalance(t.userId);
        for (const b of books.filter((x) => String(x.employee) === String(t.userId))) await ledger.recomputeKhataSpent(b._id);
        console.log(`    ${t.code}: wallet now ${money(bal)}`);
      }
    }
  }

  console.log(APPLY ? '\nDone.' : '\nDry run only — re-run with --apply to delete.');
  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
