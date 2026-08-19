/**
 * Wipe the employee khata module back to empty, for testing.
 *
 *   node scripts/resetKhata.js                    # report what it would delete
 *   node scripts/resetKhata.js --apply            # delete it
 *   node scripts/resetKhata.js --apply --keep-books   # keep the khatas and wallets, delete only the ledger
 *
 * THIS DESTROYS DATA AND CANNOT BE UNDONE. It exists because the module was
 * rebuilt around a wallet and the old test rows get in the way of exercising
 * the new flows from a clean slate. It is not a maintenance tool: nothing in
 * normal operation should ever delete a posted financial row (a correction is a
 * REVERSAL — see services/khataLedger.js).
 *
 * WHY IT IS NOT JUST `deleteMany` ON ONE COLLECTION. A khata entry that moved
 * real money also wrote a CashbookEntry, and the cash account's balance is a
 * cache derived from those rows. Deleting only the khata side would leave the
 * cashbook holding payouts to nobody and every affected account reporting a
 * balance that no longer matches its own ledger. So this script:
 *
 *   1. finds the CashbookEntry rows those khata entries posted, and deletes them
 *   2. deletes the khata entries themselves
 *   3. RECOMPUTES every cash account it touched, so the tin adds up again
 *   4. removes the receipt files the deleted entries owned, so GridFS is not
 *      left holding blobs nothing points at
 *   5. resets or removes the wallets and expense books
 *
 * What it deliberately leaves alone: Expense, Loan and Payroll records (the
 * khata only ever mirrored those — deleting the mirror does not touch the
 * source), CashbookEntry rows that khata never created, and AuditLog history.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const EmployeeKhata = require('../models/EmployeeKhata');
const EmployeeWallet = require('../models/EmployeeWallet');
const KhataEntry = require('../models/KhataEntry');
const CashbookEntry = require('../models/CashbookEntry');
const CashAccount = require('../models/CashAccount');
const storage = require('../services/storage');
const ledger = require('../services/khataLedger');

const APPLY = process.argv.includes('--apply');
const KEEP_BOOKS = process.argv.includes('--keep-books');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);
const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN')}`;

async function run() {
  await connectDB();

  const entries = await KhataEntry.find({})
    .select('_id code type direction amount status cashbookEntry cashAccount attachment employee')
    .lean();

  if (!entries.length) {
    console.log('  no khata entries — the ledger is already empty');
  } else {
    // What is about to go, in the terms somebody would recognise it by.
    const byStatus = {};
    let moved = 0;
    for (const e of entries) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      if (e.status === 'Approved') moved += ledger.signedAmount(e);
    }
    console.log(`\n  ${entries.length} khata entr(ies): `
      + Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', '));
    console.log(`  net posted movement being erased: ${money(ledger.round2(moved))}`);
  }

  // ---- 1. the cashbook leg ------------------------------------------------
  // Matched from BOTH sides: the khata row's own pointer and the cashbook row's
  // back-reference. Either can be missing on a row that failed halfway, and a
  // one-sided match would leave the other orphaned.
  const entryIds = entries.map((e) => e._id);
  const cashLegs = await CashbookEntry.find({
    $or: [
      { _id: { $in: entries.map((e) => e.cashbookEntry).filter(Boolean) } },
      { sourceKhataEntry: { $in: entryIds } },
    ],
  }).select('_id account amount type').lean();

  // The accounts whose balances will need rebuilding once those rows are gone.
  const touchedAccounts = [...new Set(cashLegs.map((c) => String(c.account)).filter(Boolean))];
  say(`delete ${cashLegs.length} cashbook row(s) posted by the khata, across `
    + `${touchedAccounts.length} cash account(s)`);

  for (const id of touchedAccounts) {
    const acc = await CashAccount.findById(id).select('name currentBalance').lean();
    if (acc) console.log(`    "${acc.name}" currently ${money(acc.currentBalance)} — will be rebuilt from what is left`);
  }

  // ---- 2. receipts --------------------------------------------------------
  const receipts = entries.filter((e) => e.attachment?.storagePath);
  say(`remove ${receipts.length} receipt file(s)`);

  // ---- 3. the books -------------------------------------------------------
  const wallets = await EmployeeWallet.countDocuments({});
  const khatas = await EmployeeKhata.countDocuments({});
  if (KEEP_BOOKS) {
    say(`keep ${wallets} wallet(s) and ${khatas} khata(s), reset to zero`);
  } else {
    say(`delete ${wallets} wallet(s) and ${khatas} khata(s)`);
  }

  if (!APPLY) {
    console.log('\n  Dry run — nothing was deleted.');
    console.log('  Re-run with --apply to delete it, or --apply --keep-books to keep the books and clear only the ledger.\n');
    return;
  }

  // ---- do it --------------------------------------------------------------
  console.log('\n  deleting…');

  if (cashLegs.length) {
    await CashbookEntry.deleteMany({ _id: { $in: cashLegs.map((c) => c._id) } });
    console.log(`  removed ${cashLegs.length} cashbook row(s)`);
  }

  const delEntries = await KhataEntry.deleteMany({});
  console.log(`  removed ${delEntries.deletedCount} khata entr(ies)`);

  // Best-effort: a missing blob must not abort the reset, and an orphaned file
  // is a wasted byte rather than a wrong number.
  let removedFiles = 0;
  for (const e of receipts) {
    try { await storage.remove(e.attachment.storagePath); removedFiles += 1; } catch { /* already gone */ }
  }
  if (receipts.length) console.log(`  removed ${removedFiles}/${receipts.length} receipt file(s)`);

  // Rebuild every account the deletion touched, so the tin agrees with its own
  // ledger again. This is the step that makes the reset safe for the cashbook.
  for (const id of touchedAccounts) {
    const balance = await ledger.recomputeCashAccount(id);
    const acc = await CashAccount.findById(id).select('name').lean();
    console.log(`  rebuilt "${acc?.name || id}" -> ${money(balance)}`);
  }

  if (KEEP_BOOKS) {
    // Replay rather than assume: with no entries left every wallet lands on its
    // opening balance and every book on zero, and going through the ledger
    // proves that instead of asserting it.
    for (const k of await EmployeeKhata.find({}).select('_id')) await ledger.recomputeKhataSpent(k._id);
    for (const w of await EmployeeWallet.find({}).select('employee')) await ledger.recomputeWalletBalance(w.employee);
    console.log(`  reset ${khatas} khata(s) and ${wallets} wallet(s) to zero`);
  } else {
    await EmployeeWallet.deleteMany({});
    await EmployeeKhata.deleteMany({});
    console.log(`  removed ${wallets} wallet(s) and ${khatas} khata(s)`);
  }

  console.log('\n  Done. The khata module is empty — a wallet and a "General" book '
    + 'reopen themselves the first time anyone uses it.\n');
}

run()
  .then(() => mongoose.connection.close())
  .catch((err) => {
    console.error(err);
    return mongoose.connection.close().finally(() => process.exit(1));
  });
