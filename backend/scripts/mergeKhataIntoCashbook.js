/**
 * STAGE 4 of the khata → cashbook merge: fold every legacy KhataEntry row into
 * the unified cashbook collection as an `employee`-ledger entry.
 *
 * ─────────────────────────────  READ THIS FIRST  ─────────────────────────────
 * This rewrites live financial records. It is DRY-RUN BY DEFAULT and will not
 * change anything until you pass --commit.
 *
 *     node scripts/mergeKhataIntoCashbook.js            # report only, no writes
 *     node scripts/mergeKhataIntoCashbook.js --commit   # actually migrate
 *
 * TAKE A DATABASE BACKUP BEFORE RUNNING WITH --commit. There is no undo.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES, and why it is not a straight copy:
 *
 * Before the merge a single advance wrote TWO rows — a KhataEntry (the
 * employee's side) and a separate CashbookEntry (the company-cash leg),
 * cross-linked. After the merge there is ONE row carrying both. So:
 *
 *   • KhataEntry WITH a linked cashbookEntry → the cash row already exists.
 *     We UPGRADE that existing CashbookEntry in place: stamp it as an employee
 *     ledger row and copy the employee-side fields onto it. Creating a new row
 *     here would double-count the money.
 *
 *   • KhataEntry WITHOUT a linked cashbookEntry (an own-money expense, a
 *     payroll recovery, or anything still Pending) → INSERT a new employee row.
 *
 * The legacy KhataEntry documents are left untouched, so the old collection
 * remains as a read-only record you can reconcile against. Nothing is deleted.
 *
 * Re-running is safe: a KhataEntry whose migrated row already exists is skipped
 * (matched on `migratedFrom`).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const KhataEntry = require('../models/KhataEntry');
const CashbookEntry = require('../models/CashbookEntry');

const COMMIT = process.argv.includes('--commit');

// Field-by-field translation from the old employee ledger to the unified row.
function toEmployeeRow(k) {
  return {
    ledger: 'employee',
    // identity / money
    code: k.code || undefined,
    employee: k.employee,
    expenseBook: k.khata || null,
    direction: k.direction,
    movement: k.type || 'other',
    // The company's view of the same movement.
    type: k.direction === 'to_employee' ? 'out' : 'in',
    amount: k.amount,
    date: k.date,
    // descriptions: the employee side keeps `purpose`; the account view reads
    // `description`, so seed it from the same text.
    purpose: k.purpose,
    description: k.purpose || undefined,
    category: k.category || 'Uncategorized',
    paymentMode: k.paymentMode === 'Adjustment' ? 'Other' : (k.paymentMode || 'Cash'),
    referenceNo: k.referenceNo,
    attachment: k.attachment || null,
    status: k.status,
    // company cash leg
    affectsCompanyCash: k.affectsCompanyCash !== false,
    account: k.cashAccount || undefined,
    // employee-side extras
    filedLocation: k.filedLocation || null,
    raisedByEmployee: k.raisedByEmployee === true,
    walletBalanceAfter: k.balanceAfter,
    execApprovalRequired: k.execApprovalRequired === true,
    execApprovedBy: k.execApprovedBy || null,
    execApprovedAt: k.execApprovedAt || null,
    execNote: k.execNote,
    confirmedByCompany: k.confirmedByCompany === true,
    confirmedBy: k.confirmedBy || null,
    confirmedAt: k.confirmedAt || null,
    edits: k.edits || [],
    reversalReason: k.reversalReason,
    idempotencyKey: k.idempotencyKey || undefined,
    sourceLoan: k.sourceLoan || null,
    sourceExpense: k.sourceExpense || null,
    sourcePayroll: k.sourcePayroll || null,
    createdBy: k.createdBy,
    reviewedBy: k.reviewedBy,
    reviewedAt: k.reviewedAt,
    reviewNote: k.reviewNote,
    // provenance, and what makes a re-run idempotent
    migratedFrom: k._id,
  };
}

(async () => {
  await connectDB();
  const col = CashbookEntry.collection;

  const khataRows = await KhataEntry.find({}).lean();
  console.log(`Found ${khataRows.length} legacy employee-ledger rows.`);

  let upgrade = 0; let insert = 0; let skip = 0;
  const ops = [];
  // Map old KhataEntry _id -> the unified row id, so the reversal chain can be
  // re-pointed in the second pass.
  const idMap = new Map();

  for (const k of khataRows) {
    const already = await col.findOne({ migratedFrom: k._id }, { projection: { _id: 1 } });
    if (already) { skip += 1; idMap.set(String(k._id), already._id); continue; }

    const row = toEmployeeRow(k);
    if (k.cashbookEntry) {
      // The cash leg exists — upgrade it in place rather than adding money.
      const legId = k.cashbookEntry;
      idMap.set(String(k._id), legId);
      // Keep the leg's own code/account/balanceAfter (the account's running
      // balance), and overlay the employee-side fields.
      const { code, description, category, paymentMode, type, account, ...employeeSide } = row;
      ops.push({ updateOne: { filter: { _id: legId }, update: { $set: employeeSide } } });
      upgrade += 1;
    } else {
      const _id = new mongoose.Types.ObjectId();
      idMap.set(String(k._id), _id);
      ops.push({ insertOne: { document: { ...row, _id, createdAt: k.createdAt, updatedAt: k.updatedAt } } });
      insert += 1;
    }
  }

  console.log(`\nPlan: upgrade ${upgrade} existing cash rows, insert ${insert} new rows, skip ${skip} already migrated.`);

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing written. Re-run with --commit (after a backup) to apply.');
    await mongoose.disconnect();
    return;
  }

  if (ops.length) {
    const res = await col.bulkWrite(ops, { ordered: false });
    console.log(`Wrote: ${res.insertedCount || 0} inserted, ${res.modifiedCount || 0} updated.`);
  }

  // Second pass: re-point the reversal chain at the new row ids.
  const chainOps = [];
  for (const k of khataRows) {
    const selfId = idMap.get(String(k._id));
    if (!selfId) continue;
    const set = {};
    if (k.reversalOf && idMap.get(String(k.reversalOf))) set.reversalOf = idMap.get(String(k.reversalOf));
    if (k.reversedBy && idMap.get(String(k.reversedBy))) set.reversedBy = idMap.get(String(k.reversedBy));
    if (Object.keys(set).length) chainOps.push({ updateOne: { filter: { _id: selfId }, update: { $set: set } } });
  }
  if (chainOps.length) {
    const res2 = await col.bulkWrite(chainOps, { ordered: false });
    console.log(`Re-pointed ${res2.modifiedCount || 0} reversal links.`);
  }

  // Stamp the legacy company rows so every document has an explicit ledger.
  const stamped = await col.updateMany(
    { ledger: { $exists: false } },
    { $set: { ledger: 'company' } }
  );
  console.log(`Stamped ${stamped.modifiedCount} pre-existing rows as company ledger.`);

  console.log('\nDone. The legacy khataentries collection is untouched — reconcile against it, '
    + 'then archive it once you are satisfied.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
