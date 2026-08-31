/**
 * Reset staff passwords to firstName + the digits of their employee code.
 *
 *   node scripts/resetPasswordsToFormula.js              # dry run — lists, changes nothing
 *   node scripts/resetPasswordsToFormula.js --apply      # actually reset
 *   node scripts/resetPasswordsToFormula.js --only SSL\ 61,SSL\ 84
 *   node scripts/resetPasswordsToFormula.js --apply --max 5
 *
 * "Yash Kumar Roy (SSL 120)" -> "Yash120".
 *
 * READ THIS BEFORE RUNNING IT.
 *
 * The resulting passwords are DERIVABLE, not secret. Both halves are on display
 * inside the app: first names are in the employee directory and every people
 * picker, and employee codes are printed beside them ("Sandeepa T.U (SSL 11)").
 * So after this runs, any employee who guesses the pattern can sign in as any
 * colleague — and as anyone whose password they can derive, which is everybody
 * this script touches. It is a reasonable way to hand out a STARTING password
 * that people change immediately; it is not a state to leave the portal in.
 *
 * There is no "must change password at next login" flag in this codebase, so
 * nothing forces the follow-up. Whoever runs this should tell people to change
 * their password (Settings -> Change password on the app, or Account in the web
 * portal) and should expect to chase the ones who do not.
 *
 * WHAT IT SKIPS, and why:
 *   - CEO, MD and SuperAdmin accounts — the roles that are not employees and,
 *     between them, hold every override in the system;
 *   - anyone matched by --skip (defaults to the first name "Yash"), so the person
 *     running it does not lock themselves into a guessable password;
 *   - inactive accounts;
 *   - anyone with no employee profile, no employee code, no digits in that code,
 *     or no first name — there is no formula for them. Each is reported.
 *
 * SIDE EFFECT, by design: setting a password bumps `tokenVersion` (models/User.js),
 * and every issued JWT carries it. So everyone this touches is signed out of every
 * device immediately and must sign in again with the new password.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ONLY = valueOf('--only', '').split(',').map((v) => v.trim()).filter(Boolean);
const SKIP_NAMES = valueOf('--skip', 'Yash').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
const MAX = Number(valueOf('--max', '0')) || 0;

// Never touched, whatever the flags say. These are the three roles the codebase
// treats as non-employees, and they are the accounts that can undo a mistake here.
const PROTECTED_ROLES = ['SuperAdmin', 'CEO', 'MD'];

const digitsOf = (code) => String(code || '').replace(/\D/g, '');
const formulaFor = (firstName, code) => `${String(firstName || '').trim().replace(/\s+/g, '')}${digitsOf(code)}`;

(async () => {
  await connectDB();

  const profiles = await EmployeeProfile.find({})
    .select('employeeCode user')
    .populate('user', 'firstName lastName email role isActive')
    .lean();

  const targets = [];
  const skipped = [];

  for (const p of profiles) {
    const u = p.user;
    const label = `${u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '(no account)'} (${p.employeeCode || 'no code'})`;
    if (!u) { skipped.push([label, 'employee record has no login account']); continue; }
    if (!u.isActive) { skipped.push([label, 'account is inactive']); continue; }
    if (PROTECTED_ROLES.includes(u.role)) { skipped.push([label, `protected role (${u.role})`]); continue; }
    if (SKIP_NAMES.includes(String(u.firstName || '').trim().toLowerCase())) { skipped.push([label, '--skip name']); continue; }
    if (ONLY.length && !ONLY.includes(p.employeeCode)) { skipped.push([label, 'not in --only']); continue; }
    if (!String(u.firstName || '').trim()) { skipped.push([label, 'no first name — no formula']); continue; }
    if (!digitsOf(p.employeeCode)) { skipped.push([label, 'employee code has no digits — no formula']); continue; }

    const password = formulaFor(u.firstName, p.employeeCode);
    // models/User.js sets minlength 3.
    if (password.length < 3) { skipped.push([label, `formula too short ("${password}")`]); continue; }
    targets.push({ id: u._id, label, email: u.email, role: u.role, password });
  }

  console.log(`\n${targets.length} account(s) would be reset; ${skipped.length} skipped.\n`);
  for (const t of targets) console.log(`  ${t.label.padEnd(38)} ${t.email.padEnd(34)} -> ${t.password}`);
  if (skipped.length) {
    console.log('\nSkipped:');
    for (const [label, why] of skipped) console.log(`  ${label.padEnd(38)} ${why}`);
  }

  if (MAX && targets.length > MAX) {
    console.log(`\nRefusing to run: ${targets.length} accounts match but --max is ${MAX}.\n`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing changed. Re-run with --apply to reset these passwords.');
    console.log('Remember: these passwords are derivable from the directory. Tell people to change them.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  let done = 0;
  const failed = [];
  for (const t of targets) {
    try {
      // save(), not updateOne(): the pre-save hook is what hashes the password and
      // bumps tokenVersion. An updateOne would write the plaintext straight into
      // the document and leave every old session valid.
      const user = await User.findById(t.id).select('+password');
      if (!user) { failed.push([t.label, 'account disappeared']); continue; }
      user.password = t.password;
      await user.save();
      done += 1;
    } catch (err) {
      failed.push([t.label, err.message]);
    }
  }

  console.log(`\n  Reset ${done} password(s).`);
  if (failed.length) {
    console.log(`  ${failed.length} failed:`);
    for (const [label, why] of failed) console.log(`    ${label} — ${why}`);
  }
  console.log('  Everyone reset has been signed out of every device.');
  console.log('  Tell them to sign in and change it: Settings -> Change password.\n');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
