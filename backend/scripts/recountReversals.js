/**
 * Re-count the wallets, books and cash accounts that a reversal touched, now
 * that a Reversed row counts beside the reversal that cancels it.
 *
 * WHY THIS EXISTS. Until 2026-09-26 every balance counted `Approved` rows alone.
 * A reversal marks the original `Reversed` and posts a mirror row, so the old
 * rule dropped the original and kept the mirror: every reversal credited the
 * person's wallet a SECOND time, took the amount off the book's cost a second
 * time, and (for an advance that moved company cash) would have put it back into
 * the cash account twice. The code now counts both halves (POSTED_STATUSES in
 * models/CashbookEntry.js) — but a wallet's `balance`, a book's `spent` and an
 * account's `currentBalance` are stored copies, replayed only when something
 * next happens to them. This replays the ones a reversal touched, now.
 *
 * RUN IT ONLY AFTER THE NEW BACKEND IS DEPLOYED. The deployed server still on
 * the old rule would replay a wallet the old way the next time that person files
 * anything, putting the double credit straight back.
 *
 * DRY RUN unless --apply is passed, and --apply touches only the people NAMED
 * (by employee code) or, with --all, everyone listed. Nothing here writes a
 * ledger row: it recomputes figures that are derived from the rows, which is
 * what the Super Admin's "recompute" repair button does one person at a time.
 *
 *   node scripts/recountReversals.js                      # what would change
 *   node scripts/recountReversals.js "SSL 12" --apply     # fix those people
 *   node scripts/recountReversals.js --all --apply        # fix everyone listed
 *
 * A WALLET THAT DOES NOT MATCH THE OLD RULE EITHER is flagged: its stored
 * figure was changed by something other than the reversal bug (a wipe with
 * scripts/deleteKhataForEmployees.js, a restored backup), and recomputing it
 * would bring back rows somebody may have meant to be gone. Look before naming
 * one of those.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
require('../models/User');
const CashbookEntry = require('../models/CashbookEntry');
const { POSTED_STATUSES } = require('../models/CashbookEntry');
const EmployeeWallet = require('../models/EmployeeWallet');
const EmployeeKhata = require('../models/EmployeeKhata');
const EmployeeProfile = require('../models/EmployeeProfile');
const CashAccount = require('../models/CashAccount');
const ledger = require('../services/khataLedger');

const Entry = CashbookEntry.EmployeeLedgerEntry;
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const CODES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
const r2 = ledger.round2;
const signed = (e) => (e.direction === 'to_employee' ? e.amount : -e.amount);
const sumBy = (rows, statuses, f) => r2(rows.filter((e) => statuses.includes(e.status)).reduce((s, e) => s + f(e), 0));
const money = (n) => `${Number(n) < 0 ? '-' : ''}₹${Math.abs(Number(n) || 0).toLocaleString('en-IN')}`;

(async () => {
  await connectDB();
  if (APPLY && !ALL && !CODES.length) {
    throw new Error('--apply needs employee codes (or --all). Run without --apply first to see who is affected.');
  }
  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — reversal re-count${CODES.length ? ` for ${CODES.join(', ')}` : ''}\n`);

  const touched = await CashbookEntry.find({ $or: [{ status: 'Reversed' }, { movement: 'reversal' }] })
    .select('employee expenseBook account').lean();
  const people = [...new Set(touched.filter((e) => e.employee).map((e) => String(e.employee)))];
  const accounts = [...new Set(touched.filter((e) => e.account).map((e) => String(e.account)))];
  const profiles = await EmployeeProfile.find({ user: { $in: people } }).select('user employeeCode').lean();
  const codeOf = new Map(profiles.map((p) => [String(p.user), p.employeeCode || '']));
  const wanted = (id) => ALL || CODES.some((c) => loose(c) === loose(codeOf.get(id)));

  let changes = 0;
  for (const id of people) {
    const wallet = await EmployeeWallet.findOne({ employee: id }).populate('employee', 'firstName lastName').lean();
    const rows = await Entry.find({ employee: id }).select('status direction amount expenseBook').lean();
    const opening = wallet?.openingBalance || 0;
    const before = r2(wallet?.balance || 0);
    const oldRule = r2(opening + sumBy(rows, ['Approved'], signed));
    const fixed = r2(opening + sumBy(rows, POSTED_STATUSES, signed));
    const name = wallet?.employee ? `${wallet.employee.firstName} ${wallet.employee.lastName || ''}`.trim() : id;
    const code = codeOf.get(id) || '—';
    const flag = before !== oldRule
      ? '  ⚠ stored figure matches neither rule — changed by something else (a wipe?); look before naming it'
      : '';
    console.log(`${code.padEnd(8)} ${name.padEnd(26)} wallet ${money(before).padStart(12)} → ${money(fixed).padStart(12)}${fixed === before ? '  (no change)' : ''}${flag}`);

    const bookIds = [...new Set(rows.filter((e) => e.expenseBook).map((e) => String(e.expenseBook)))];
    for (const b of bookIds) {
      const book = await EmployeeKhata.findById(b).select('name spent').lean();
      const bookRows = await Entry.find({ expenseBook: b, movement: { $in: [...ledger.BOOK_MOVEMENTS, 'reversal'] } })
        .select('status direction amount').lean();
      const spent = sumBy(bookRows, POSTED_STATUSES, (e) => -signed(e));
      if (!book) { console.log(`           book ${b}: no longer exists (its rows are still on the ledger)`); continue; }
      console.log(`           book "${book.name}": spent ${money(book.spent)} → ${money(spent)}${spent === r2(book.spent || 0) ? '  (no change)' : ''}`);
      if (spent !== r2(book.spent || 0)) changes += 1;
    }
    if (fixed !== before) changes += 1;

    if (APPLY && wanted(id)) {
      await ledger.recomputeWalletBalance(id);
      for (const b of bookIds) await ledger.recomputeKhataSpent(b); // a missing book is a no-op
      console.log('           ✓ recomputed');
    }
  }

  for (const id of accounts) {
    const acc = await CashAccount.findById(id).lean();
    if (!acc) continue;
    const rows = await CashbookEntry.find({ account: id }).select('status type amount').lean();
    const fixed = r2((acc.openingBalance || 0) + sumBy(rows, POSTED_STATUSES, (e) => (e.type === 'in' ? e.amount : -e.amount)));
    console.log(`account "${acc.name}": ${money(acc.currentBalance)} → ${money(fixed)}`);
    if (fixed !== r2(acc.currentBalance || 0)) changes += 1;
    if (APPLY && ALL) {
      await ledger.recomputeCashAccount(id);
      console.log('           ✓ recomputed');
    }
  }
  if (!accounts.length) console.log('No cash account carries a reversed row.');

  console.log(`\n${changes} figure${changes === 1 ? '' : 's'} would change${APPLY ? ' (the named ones have been recomputed)' : ''}.`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error(e.message);
  await mongoose.disconnect();
  process.exit(1);
});
