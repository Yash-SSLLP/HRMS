/**
 * Hand one person's org-chart references over to another account.
 *
 * Why this exists: when somebody leaves, finalizeExit deactivates their login
 * but every employee who named them keeps pointing at the dead account — their
 * HR partner, the HR recipients of a fully-approved leave, the regularization
 * ladder. Nothing errors, because the ladder builders skip inactive users at
 * approval time, so the damage is silent: the notice reaches nobody, the ladder
 * has a hole in it, and the replacement HR Manager sees only the handful of
 * employees actually partnered to them (hrPartner is what scopes an HR
 * Manager's view of the org — see utils/employeeScope).
 *
 * This is the seat handover the exit flow does not do: move every reference
 * from the outgoing account to the incoming one.
 *
 * It matters most when the seat is reissued along with the work ADDRESS, since
 * the two accounts then look identical in every list — same email, same role —
 * and only the id tells them apart. That is why --from/--to take an id or an
 * employee code, and an email only while it still names one account.
 *
 * Run (from backend/):
 *   node scripts/reassignPersonReferences.js --from <id|code|email> --to <id|code|email>
 *   node scripts/reassignPersonReferences.js --from ... --to ... --apply
 *
 * Without --apply nothing is written: it prints what it would move. Safe to
 * re-run — a reference already pointing at --to is left alone.
 */
require('dotenv').config();
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const mongoose = require('mongoose');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const { normalizeCode } = require('../utils/loginIdentity');

const APPLY = process.argv.includes('--apply');

/** Read `--name value` off argv. */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Single-value pointers, and the ordered/unordered id lists.
const SCALAR_FIELDS = ['hrPartner', 'reportingManager'];
const ARRAY_FIELDS = ['leaveApprovers', 'leaveFinalHrRecipients', 'regularizationApprovers'];

const label = (u) =>
  `${u.firstName || ''} ${u.lastName || ''}`.trim() + ` <${u.email}> (${u.role}, ${u.isActive === false ? 'inactive' : 'ACTIVE'}) ${u._id}`;

/**
 * Resolve one --from/--to argument to exactly one account.
 *
 * An email is accepted only while it names a single account: the whole point of
 * a reissued address is that it names two, and picking "whichever Mongo
 * returned first" is how the wrong person's employees get handed over.
 */
async function resolveAccount(value, what) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`--${what} is required (an account id, an employee code, or an email).`);

  if (mongoose.isValidObjectId(raw)) {
    const u = await User.findById(raw).select('_id firstName lastName email role isActive').lean();
    if (u) return u;
  }

  const profile = await EmployeeProfile.findOne({ employeeCode: normalizeCode(raw) }).select('user').lean();
  if (profile?.user) {
    const u = await User.findById(profile.user).select('_id firstName lastName email role isActive').lean();
    if (u) return u;
  }

  const matches = await User.find({ email: raw.toLowerCase() })
    .select('_id firstName lastName email role isActive').lean();
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`\n"${raw}" is held by ${matches.length} accounts, so it cannot say which one you mean:`);
    matches.forEach((u) => console.error(`   ${label(u)}`));
    throw new Error(`Pass --${what} the account id (or employee code) instead of the address.`);
  }

  throw new Error(`No account matches --${what} "${raw}".`);
}

async function main() {
  await connectDB();

  const from = await resolveAccount(arg('from'), 'from');
  const to = await resolveAccount(arg('to'), 'to');
  if (String(from._id) === String(to._id)) throw new Error('--from and --to are the same account.');

  console.log(`\nfrom  ${label(from)}`);
  console.log(`to    ${label(to)}`);
  if (to.isActive === false) {
    console.log('\nWARNING: --to is a DEACTIVATED account. Every ladder builder skips inactive');
    console.log('users, so this would move the references onto another dead end.');
  }

  const fromId = String(from._id);
  const toId = String(to._id);

  const profiles = await EmployeeProfile.find({
    $or: [...SCALAR_FIELDS, ...ARRAY_FIELDS].map((f) => ({ [f]: from._id })),
  }).select(`employeeCode user ${[...SCALAR_FIELDS, ...ARRAY_FIELDS].join(' ')}`)
    .populate('user', 'firstName lastName');

  if (!profiles.length) {
    console.log('\nNothing references that account. Nothing to do.');
    return;
  }

  const tally = {};
  let changed = 0;

  for (const p of profiles) {
    const who = `${p.employeeCode} — ${`${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim()}`;
    // Handing the seat to this employee's OWN account would make them their own
    // manager or approver, which validateHierarchy refuses and the approval
    // ladders cannot use. Drop the reference instead of redirecting it.
    const isSelf = String(p.user?._id || p.user || '') === toId;
    const moves = [];

    for (const f of SCALAR_FIELDS) {
      if (String(p[f] || '') !== fromId) continue;
      if (isSelf) { p[f] = null; moves.push(`${f}: cleared (would be their own)`); }
      else { p[f] = to._id; moves.push(f); }
      tally[f] = (tally[f] || 0) + 1;
    }

    for (const f of ARRAY_FIELDS) {
      const ids = (p[f] || []).map(String);
      if (!ids.includes(fromId)) continue;
      // Redirect in place so an ORDERED ladder keeps its rung order, then drop
      // any duplicate the swap created (the incoming person may already be on
      // the list) and any self-reference.
      const seen = new Set();
      const next = ids
        .map((id) => (id === fromId ? toId : id))
        .filter((id) => !(isSelf && id === toId))
        .filter((id) => (seen.has(id) ? false : seen.add(id)));
      p[f] = next;
      moves.push(isSelf && !next.includes(toId) ? `${f}: removed (would be their own)` : f);
      tally[f] = (tally[f] || 0) + 1;
    }

    if (!moves.length) continue;
    changed += 1;
    console.log(`  ${who}\n     ${moves.join(', ')}`);
    // save(), not updateOne: the schema validators and the audit plugins are the
    // reason the rest of the portal can trust these fields.
    if (APPLY) await p.save();
  }

  console.log(`\n${changed} employee record${changed === 1 ? '' : 's'} affected:`);
  Object.entries(tally).forEach(([f, n]) => console.log(`   ${f}: ${n}`));

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to move them.');
  } else {
    console.log('\nApplied.');
  }
}

main()
  .catch((err) => { console.error('\nFailed:', err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
