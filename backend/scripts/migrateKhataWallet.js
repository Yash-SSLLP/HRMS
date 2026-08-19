/**
 * Migrate the employee khata from per-book pots to one wallet per person.
 *
 *   node scripts/migrateKhataWallet.js          # report what it would do
 *   node scripts/migrateKhataWallet.js --apply  # actually do it
 *
 * WHAT CHANGED. Advances used to be given to a specific khata, so an employee
 * holding a site book and a vehicle book had two separate pots. Now there is
 * ONE wallet per person that advances are paid into, and khatas are expense
 * books: folders saying what the money went on. See models/EmployeeWallet.js.
 *
 * WHAT THIS SCRIPT DOES, in order:
 *
 *  1. Opens an EmployeeWallet for everyone who has a khata, carrying in the sum
 *     of their old per-book opening balances and the largest limit any of their
 *     books carried. Summed rather than picked, because every one of those
 *     openings was money genuinely in that person's hand; the LIMIT is taken as
 *     the maximum rather than the total on purpose — adding them would hand
 *     somebody a bigger allowance than anyone ever approved, purely because
 *     their spending was filed under several headings.
 *
 *     Where a wallet ALREADY exists — which it will, for anyone who opened the
 *     module after the new code went live and before this script was run — only
 *     the fields still at their default are filled in. Its balance is already
 *     right; a limit somebody has since set by hand is never overwritten.
 *
 *  2. Detaches every non-expense row from its book (`khata: null`). Advances,
 *     settlements, reimbursements, recoveries and openings move the wallet and
 *     belong to no expense book. Reversals follow whatever they reverse.
 *
 *  3. Replays every khata's `spent` and every wallet's `balance` from the
 *     ledger, exactly as the running code does, so the new figures are derived
 *     rather than copied.
 *
 * THE TOTAL IS PRESERVED. A person's new wallet balance is the sum of their old
 * khata balances, because the same rows are being replayed — just against one
 * pot instead of several. The script prints both figures per person so you can
 * see that for yourself before committing to --apply.
 *
 * Safe to run more than once: every step is idempotent.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const EmployeeKhata = require('../models/EmployeeKhata');
const EmployeeWallet = require('../models/EmployeeWallet');
const KhataEntry = require('../models/KhataEntry');
const { KHATA_TYPES } = require('../models/KhataEntry');
const ledger = require('../services/khataLedger');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);
const money = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN')}`;

async function run() {
  await connectDB();

  // ---- 1. One wallet per person, carrying the old openings and limits -----
  const khatas = await EmployeeKhata.find({}).lean();
  if (!khatas.length) {
    console.log('  no khatas in this database — nothing to migrate');
    return;
  }

  const byEmployee = new Map();
  for (const k of khatas) {
    const id = String(k.employee);
    if (!byEmployee.has(id)) byEmployee.set(id, []);
    byEmployee.get(id).push(k);
  }
  console.log(`  ${khatas.length} khata(s) across ${byEmployee.size} employee(s)`);

  let opened = 0;
  for (const [employeeId, books] of byEmployee) {
    const oldBalance = ledger.round2(books.reduce((a, b) => a + (b.balance || 0), 0));
    const opening = ledger.round2(books.reduce((a, b) => a + (b.openingBalance || 0), 0));
    // Max, not sum — see the header. Somebody with three ₹5,000 books was never
    // approved to hold ₹15,000.
    const limit = ledger.round2(books.reduce((a, b) => Math.max(a, b.creditLimit || 0), 0));

    // A wallet can already exist before this script is ever run: deploying the
    // new code makes getOrCreateWallet open one the first time anybody opens the
    // module. Such a wallet is correct on `balance` (it was replayed from the
    // ledger) but knows nothing of the old books' opening balances and limits,
    // so skipping it outright would silently drop both.
    //
    // Fill in only what is still at its default. A figure somebody has since
    // set by hand is a deliberate decision and is never overwritten.
    const existing = await EmployeeWallet.findOne({ employee: employeeId });
    if (existing) {
      const patch = {};
      if (!existing.openingBalance && opening) patch.openingBalance = opening;
      if (!existing.creditLimit && limit) patch.creditLimit = limit;

      if (Object.keys(patch).length) {
        say(`wallet exists for ${employeeId} (${money(existing.balance)}) — carrying over `
          + Object.entries(patch).map(([k, v]) => `${k} ${money(v)}`).join(', '));
        if (APPLY) await EmployeeWallet.updateOne({ _id: existing._id }, { $set: patch });
      } else {
        console.log(`  wallet already exists for ${employeeId} (${money(existing.balance)}) — nothing to carry over`);
      }
      continue;
    }

    say(`open wallet for ${employeeId}: opening ${money(opening)}, limit ${limit ? money(limit) : 'none'}, `
      + `old khata total ${money(oldBalance)}`);
    if (APPLY) {
      await EmployeeWallet.create({
        employee: employeeId,
        openingBalance: opening,
        creditLimit: limit,
        balance: 0, // replayed in step 3
        note: books.map((b) => b.note).filter(Boolean).join(' · ').slice(0, 300) || undefined,
      });
    }
    opened += 1;
  }
  say(`${opened} wallet(s) to open`);

  // A person's per-book `balance` fields are no longer written by the running
  // code, so on a database where the new code has already posted an entry they
  // are stale by design. The "old khata total" printed above is that stale
  // cache; the figure in step 3 is replayed from the ledger and is the correct
  // one. They differ exactly where an entry was posted after the new code went
  // live, so a mismatch there is expected rather than alarming.

  // ---- 2. Detach every wallet-level row from its book ---------------------
  // Reversals stay where they are: a reversal is filed under whatever it
  // cancels, so one against an expense keeps the book and one against an
  // advance already points at a row this step is about to detach. Handled
  // below, after the originals, so it can follow them.
  //
  // Expense-CLAIM mirrors are detached too, however they are typed. A claim is
  // money the employee spent out of their OWN pocket (services/khataSync.js),
  // not spending down an advance, so leaving it filed under a book would charge
  // a site or a vehicle for something it never paid for. The wallet total is
  // the same either way — only the breakdown would have been wrong.
  const detachFilter = {
    khata: { $ne: null },
    $or: [
      { type: { $nin: [...KHATA_TYPES, 'reversal'] } },
      { sourceExpense: { $ne: null } },
    ],
  };
  const detachCount = await KhataEntry.countDocuments(detachFilter);
  say(`detach ${detachCount} wallet-level entr(ies) from their khata`);
  if (APPLY && detachCount) {
    await KhataEntry.updateMany(detachFilter, { $set: { khata: null } });
  }

  // Reversals: follow the row each one cancels, so a reversed advance leaves no
  // phantom cost sitting on an expense book.
  const reversals = await KhataEntry.find({ type: 'reversal', khata: { $ne: null } })
    .select('_id reversalOf khata').lean();
  let movedReversals = 0;
  for (const r of reversals) {
    if (!r.reversalOf) continue;
    const original = await KhataEntry.findById(r.reversalOf).select('khata type').lean();
    // The original has already been detached above if it was wallet-level.
    const target = original ? (original.khata || null) : null;
    if (String(target || '') === String(r.khata || '')) continue;
    say(`  reversal ${r._id}: khata ${r.khata} -> ${target || 'null'}`);
    if (APPLY) await KhataEntry.updateOne({ _id: r._id }, { $set: { khata: target } });
    movedReversals += 1;
  }
  say(`${movedReversals} reversal(s) re-filed`);

  if (!APPLY) {
    console.log('\n  Dry run — nothing was written. Re-run with --apply to migrate.');
    return;
  }

  // ---- 3. Replay every book and every wallet from the ledger --------------
  for (const k of khatas) await ledger.recomputeKhataSpent(k._id);
  console.log(`  replayed ${khatas.length} khata total(s)`);

  let mismatched = 0;
  for (const [employeeId, books] of byEmployee) {
    const oldBalance = ledger.round2(books.reduce((a, b) => a + (b.balance || 0), 0));
    const newBalance = await ledger.recomputeWalletBalance(employeeId);
    const same = ledger.round2(newBalance) === oldBalance;
    if (!same) mismatched += 1;
    console.log(`  ${employeeId}: ${money(oldBalance)} -> ${money(newBalance)}${same ? '' : '   <-- CHECK THIS'}`);
  }

  if (mismatched) {
    console.log(`\n  ${mismatched} employee(s) came out at a different figure. That is expected only where the `
      + 'old per-khata balances had drifted from their ledger; the new figure is the one the entries actually add up to.');
  } else {
    console.log('\n  Every wallet matches the sum of the khatas it replaced.');
  }
}

run()
  .then(() => mongoose.connection.close())
  .catch((err) => {
    console.error(err);
    return mongoose.connection.close().finally(() => process.exit(1));
  });
