/**
 * One-off backfill: give existing cashbook entries and expense claims the
 * quotable reference codes (VCH-YYYY-NNNNN / EXP-YYYY-NNNNN) that new records
 * now get automatically from the pre-save hook in services/sequence.js.
 *
 * Rows are processed OLDEST FIRST so the numbering runs in the same order the
 * records were actually created — a code sequence that jumps around in time is
 * worse than no sequence at all. Codes already present are never rewritten.
 *
 * Run (from backend/):
 *   node scripts/backfillMoneyCodes.js            # dry run, writes nothing
 *   node scripts/backfillMoneyCodes.js --apply    # assign the codes
 *
 * Safe to re-run: a record that already has a code is skipped, so a second pass
 * only picks up whatever was created in between.
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const CashbookEntry = require('../models/CashbookEntry');
const Expense = require('../models/Expense');
const { nextCode } = require('../services/sequence');

const APPLY = process.argv.includes('--apply');

/**
 * Stamp codes on one collection.
 * @param {import('mongoose').Model} Model
 * @param {string} prefix - 'VCH' | 'EXP'
 * @param {string} dateField - field holding the record date
 * @returns {Promise<number>} how many rows were (or would be) stamped
 */
async function backfill(Model, prefix, dateField) {
  const rows = await Model.find({ $or: [{ code: { $exists: false } }, { code: null }, { code: '' }] })
    .select(`_id ${dateField} amount`)
    .sort({ [dateField]: 1, createdAt: 1, _id: 1 });

  console.log(`\n${Model.modelName}: ${rows.length} without a code`);
  let n = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const code = APPLY
      ? await nextCode(prefix, row.get(dateField))
      : `${prefix}-${new Date(row.get(dateField) || Date.now()).getFullYear()}-(dry-run)`;
    if (APPLY) {
      // updateOne, not save(): bypasses the pre-save hook (which would mint a
      // SECOND code) and skips validation on old rows that may predate a
      // required field.
      // eslint-disable-next-line no-await-in-loop
      await Model.updateOne({ _id: row._id }, { $set: { code } });
    }
    n += 1;
    if (n <= 10 || n % 100 === 0) {
      console.log(`  ${code}  ${new Date(row.get(dateField) || 0).toISOString().slice(0, 10)}  ₹${row.amount ?? '-'}`);
    }
  }
  if (rows.length > 10) console.log(`  … ${rows.length - Math.min(10, rows.length)} more`);
  return n;
}

async function main() {
  await connectDB();
  if (!APPLY) console.log('DRY RUN — nothing is written. Re-run with --apply.');

  const vouchers = await backfill(CashbookEntry, 'VCH', 'date');
  const claims = await backfill(Expense, 'EXP', 'expenseDate');

  console.log(`\n${APPLY ? 'Stamped' : 'Would stamp'} ${vouchers} cashbook entr${vouchers === 1 ? 'y' : 'ies'} and ${claims} expense claim(s).`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
