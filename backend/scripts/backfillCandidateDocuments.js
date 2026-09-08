/**
 * One-off backfill: carry hiring documents AND the portal's own offer and
 * appointment letters into the records of employees who were converted BEFORE
 * the conversion started doing it automatically.
 *
 * Those employees' records opened empty, so HR asked them for the same PAN and
 * Aadhaar a second time — and the letters the company had issued them were
 * nowhere on their record at all. This walks every candidate who has already
 * become an employee and copies both sets onto their employee record, using the
 * same services the live conversion uses (services/candidateDocuments) — so the
 * rules are identical: rejected documents are left behind, documents verified
 * during hiring arrive Verified, generated letters arrive Submitted for HR to
 * verify, and the bytes are re-saved under the employee rather than shared with
 * the candidate record.
 *
 * Run (from backend/):
 *   node scripts/backfillCandidateDocuments.js                 # dry run, writes nothing
 *   node scripts/backfillCandidateDocuments.js --apply         # actually copy
 *   node scripts/backfillCandidateDocuments.js --apply --code SSL126   # one employee
 *
 * Safe to run more than once: a file whose exact content is already on the
 * employee is skipped, so re-running never produces duplicates.
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const Candidate = require('../models/Candidate');
const EmployeeProfile = require('../models/EmployeeProfile');
const { copyCandidateDocuments, copyCandidateLetters } = require('../services/candidateDocuments');

const APPLY = process.argv.includes('--apply');
const codeArg = process.argv.indexOf('--code');
const ONLY_CODE = codeArg > -1 ? process.argv[codeArg + 1] : null;

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — run this from the backend folder.');
  await connectDB();

  // Anyone converted who has EITHER hiring uploads or a generated letter —
  // a candidate can easily have one and not the other.
  const filter = {
    'employee.profile': { $exists: true, $ne: null },
    $or: [
      { 'documents.files.0': { $exists: true } },
      { 'offer.letterPath': { $nin: [null, ''] } },
      { 'appointment.letterPath': { $nin: [null, ''] } },
    ],
  };
  if (ONLY_CODE) filter['employee.employeeCode'] = ONLY_CODE;

  const candidates = await Candidate.find(filter);
  console.log(`\n${APPLY ? 'BACKFILL' : 'DRY RUN (nothing will be written — pass --apply to copy)'}`);
  console.log(`${candidates.length} converted candidate${candidates.length === 1 ? '' : 's'} with documents or letters`
    + `${ONLY_CODE ? ` (filtered to ${ONLY_CODE})` : ''}\n`);

  const totals = { people: 0, copied: 0, skipped: 0, failed: 0, orphaned: 0 };

  for (const candidate of candidates) {
    const profileId = candidate.employee.profile;
    const code = candidate.employee.employeeCode || '(no code)';
    const who = `${code} · ${candidate.name}`;

    // The profile could have been deleted since the conversion.
    const profile = await EmployeeProfile.exists({ _id: profileId });
    if (!profile) {
      totals.orphaned += 1;
      console.log(`${who}\n  skipped — the employee profile no longer exists\n`);
      continue;
    }

    const actorId = candidate.employee.convertedBy || undefined;
    // Both passes read what is already on the employee before they write, so
    // running them back to back cannot double-copy a letter the first pass
    // just added.
    const uploads = await copyCandidateDocuments(candidate, profileId, actorId, { dryRun: !APPLY });
    const letters = await copyCandidateLetters(candidate, profileId, actorId, { dryRun: !APPLY });
    const res = {
      copied: uploads.copied + letters.copied,
      skipped: uploads.skipped + letters.skipped,
      failed: uploads.failed + letters.failed,
      details: [...uploads.details, ...letters.details],
    };

    totals.people += 1;
    totals.copied += res.copied;
    totals.skipped += res.skipped;
    totals.failed += res.failed;

    console.log(who);
    for (const line of res.details) console.log(`  ${line}`);
    if (!res.details.length) console.log('  nothing to carry over');

    if (APPLY && res.copied) {
      candidate.employee.documentsCopied = (candidate.employee.documentsCopied || 0) + res.copied;
      await candidate.save();
    }
    console.log('');
  }

  console.log('─'.repeat(52));
  console.log(`people processed      ${totals.people}`);
  console.log(`documents ${APPLY ? 'copied   ' : 'to copy  '}   ${totals.copied}`);
  console.log(`already present       ${totals.skipped}`);
  console.log(`could not be read     ${totals.failed}`);
  if (totals.orphaned) console.log(`profiles missing      ${totals.orphaned}`);
  if (!APPLY && totals.copied) console.log('\nRe-run with --apply to write these.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('\nBackfill failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
