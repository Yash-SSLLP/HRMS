/**
 * Scrub the plaintext passwords that the retired `password` change-request field
 * left behind, and close any request still waiting on one.
 *
 *   node scripts/scrubPasswordChangeRequests.js            # dry run — reports, changes nothing
 *   node scripts/scrubPasswordChangeRequests.js --apply    # overwrite the values and close pending rows
 *
 * WHY THIS EXISTS. `password` used to be a FIELD_CATALOG entry, so "change my
 * password" created a ChangeRequest and stored the NEW PASSWORD AS TYPED in
 * `requestedValue` (models/ChangeRequest.js: a plain String, no hashing anywhere
 * on that path). The row was never cleaned up after approval, so every password
 * ever changed that way is still sitting in the database in plain text, readable
 * by anyone who can read change requests — the employee's HR partner, any
 * SuperAdmin, and anything with database access.
 *
 * Removing the catalogue entry stops NEW ones being created. It does nothing
 * about the ones already stored. This does that.
 *
 * WHAT IT DOES, per row with `field: 'password'`:
 *   - replaces `requestedValue` (and `appliedValue`, and `currentValue` if a row
 *     ever carried one) with '••••••', so nothing readable remains;
 *   - if the row is still `pending`, declines it with a note, because the field
 *     can no longer be applied — the person changes their own password now.
 *
 * The rows are kept rather than deleted: they are the record that a change was
 * requested and what happened to it. Only the secret is destroyed.
 *
 * NOTE ON WHAT THIS CANNOT UNDO: a password that was exposed has been exposed.
 * Anyone whose password went through this workflow should change it — and can
 * now do so themselves, in My Portal.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const ChangeRequest = require('../models/ChangeRequest');

const APPLY = process.argv.includes('--apply');
const MASK = '••••••';

(async () => {
  await connectDB();

  // `field` is matched directly rather than through FIELD_CATALOG — the whole
  // point is that 'password' is no longer IN the catalogue.
  const rows = await ChangeRequest.find({ field: 'password' })
    .populate('requestedBy', 'firstName lastName email')
    .populate('targetUser', 'firstName lastName email')
    .sort({ createdAt: 1 })
    .lean();

  if (!rows.length) {
    console.log('\nNo password change requests found. Nothing to scrub.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const nameOf = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email : 'unknown');
  const readable = (v) => !!v && v !== MASK;

  let exposed = 0;
  let pending = 0;
  console.log(`\n${rows.length} password change request(s) found:\n`);
  for (const r of rows) {
    const leaks = ['requestedValue', 'appliedValue', 'currentValue'].filter((k) => readable(r[k]));
    if (leaks.length) exposed += 1;
    if (r.status === 'pending') pending += 1;
    console.log(
      `  ${new Date(r.createdAt).toISOString().slice(0, 10)}  ${r.status.padEnd(9)}  ` +
      `for ${nameOf(r.targetUser || r.requestedBy)}  ` +
      (leaks.length ? `PLAINTEXT in: ${leaks.join(', ')}` : 'already masked')
    );
  }

  console.log(`\n  ${exposed} row(s) still hold a readable password.`);
  console.log(`  ${pending} row(s) are still pending and can no longer be approved.`);

  if (!APPLY) {
    console.log('\nDry run — nothing changed. Re-run with --apply to scrub.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  let scrubbed = 0;
  let closed = 0;
  for (const r of rows) {
    const set = { requestedValue: MASK };
    if (readable(r.appliedValue)) set.appliedValue = MASK;
    if (readable(r.currentValue)) set.currentValue = MASK;
    if (r.status === 'pending') {
      set.status = 'declined';
      set.decisionNote = 'Passwords are no longer changed by request — change it yourself in My Portal.';
      set.decidedAt = new Date();
      closed += 1;
    }
    // updateOne, not save(): the auditStatus plugin on this schema would otherwise
    // write a status-transition row per document, and this is a data clean-up,
    // not somebody deciding a request.
    await ChangeRequest.updateOne({ _id: r._id }, { $set: set });
    scrubbed += 1;
  }

  console.log(`\n  Scrubbed ${scrubbed} row(s); closed ${closed} pending request(s).`);
  console.log('  Tell anyone affected to change their password — it was readable while stored.\n');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
