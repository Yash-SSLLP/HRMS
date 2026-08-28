/**
 * Diagnostic: find approval chains nobody can act on.
 *
 *   node scripts/checkStuckApprovalChains.js
 *
 * READ ONLY — it opens the database, reads, prints and disconnects. Nothing is
 * written, so it is safe to run against production.
 *
 * WHY THIS EXISTS. Approval decisions now refuse the person the request is
 * ABOUT (utils/employeeScope.js `assertNotOwnRequest`, and the wider
 * "nobody administers their own record" rule in `cannotManageProfile`). The
 * ladder BUILDERS have always dropped the applicant, so a self-approving chain
 * can only be one that was stored before those guards existed, or one produced
 * by the `topLeaveApproverFor` fallback when an employee is their own HR
 * Partner. Those requests are now correctly refused — but a refused request
 * with nobody else on its ladder does not fail loudly, it simply sits Pending
 * forever, which is why they have to be looked for rather than waited for.
 *
 * WHAT IT REPORTS, worst first:
 *   SELF      the current approver IS the applicant — refused, and stuck
 *   NO-ONE    Pending with no current approver and no chain to heal from
 *   DEAD      the current approver's account is deactivated or gone
 *   SELF-RUNG a rung further up names the applicant; it will stick when reached
 * plus the self-partnered employees that are the usual root cause.
 *
 * Nothing here fixes anything. Re-routing a stuck request is a SuperAdmin
 * decision (reassign the reporting manager / leaveApprovers, or reject and
 * have it re-raised), so this only tells you which ones and why.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { LeaveRequest } = require('../models/Leave');
const ExitRequest = require('../models/ExitRequest');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');

const id = (v) => (v == null ? '' : String(v._id || v));
const short = (v) => id(v).slice(-6);

/** Classify one Pending request against the guards that now apply to it. */
function diagnose({ subjectUserId, currentApprover, chain, approverActive }) {
  const me = String(subjectUserId || '');
  const cur = id(currentApprover);
  if (cur && me && cur === me) return 'SELF';
  if (!cur) return 'NO-ONE';
  if (approverActive === false) return 'DEAD';
  const laterSelf = (chain || []).some(
    (s) => ['Waiting', 'Pending'].includes(s.status) && id(s.approver) === me
  );
  if (laterSelf) return 'SELF-RUNG';
  return null;
}

const TONE = {
  SELF: 'stuck now — the applicant is their own approver',
  'NO-ONE': 'stuck now — no approver at all, and no chain to heal from',
  DEAD: 'stuck now — the approver’s account is inactive or deleted',
  'SELF-RUNG': 'will stick — a rung above names the applicant',
};

(async () => {
  await connectDB();

  // One pass over the people involved, so the per-request checks below need no
  // further queries.
  const profiles = await EmployeeProfile.find({}).select('user employeeCode hrPartner').lean();
  const userOf = new Map(profiles.map((p) => [id(p._id), id(p.user)]));
  const codeOf = new Map(profiles.map((p) => [id(p._id), p.employeeCode || '—']));
  const users = await User.find({}).select('firstName lastName isActive').lean();
  const nameOf = new Map(users.map((u) => [id(u._id), `${u.firstName || ''} ${u.lastName || ''}`.trim()]));
  const activeOf = new Map(users.map((u) => [id(u._id), u.isActive !== false]));

  const report = (label, rows) => {
    console.log(`\n${label}`);
    if (!rows.length) { console.log('  none'); return; }
    for (const r of rows) {
      console.log(`  [${r.kind.padEnd(9)}] ${r.who}  (${r.code})  raised ${r.when}`);
      console.log(`              ${TONE[r.kind]}`);
      if (r.approver) console.log(`              current approver: ${r.approver}`);
    }
  };

  // ---- Leave -------------------------------------------------------------
  const leaves = await LeaveRequest.find({ status: 'Pending' })
    .select('employee currentApprover approvalChain appliedAt leaveType').lean();
  const leaveRows = [];
  for (const r of leaves) {
    const subject = userOf.get(id(r.employee));
    const kind = diagnose({
      subjectUserId: subject,
      currentApprover: r.currentApprover,
      chain: r.approvalChain,
      approverActive: r.currentApprover ? activeOf.get(id(r.currentApprover)) : undefined,
    });
    if (!kind) continue;
    leaveRows.push({
      kind,
      who: nameOf.get(subject) || `user ${short(subject)}`,
      code: codeOf.get(id(r.employee)),
      when: r.appliedAt ? new Date(r.appliedAt).toISOString().slice(0, 10) : '—',
      approver: r.currentApprover
        ? `${nameOf.get(id(r.currentApprover)) || short(r.currentApprover)}${activeOf.get(id(r.currentApprover)) === false ? ' [inactive]' : ''}`
        : null,
    });
  }

  // ---- Exits -------------------------------------------------------------
  const exits = await ExitRequest.find({ status: 'Pending' })
    .select('employee currentApprover approvalChain createdAt').lean();
  const exitRows = [];
  for (const r of exits) {
    const subject = userOf.get(id(r.employee));
    const kind = diagnose({
      subjectUserId: subject,
      currentApprover: r.currentApprover,
      chain: r.approvalChain,
      approverActive: r.currentApprover ? activeOf.get(id(r.currentApprover)) : undefined,
    });
    if (!kind) continue;
    exitRows.push({
      kind,
      who: nameOf.get(subject) || `user ${short(subject)}`,
      code: codeOf.get(id(r.employee)),
      when: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '—',
      approver: r.currentApprover
        ? `${nameOf.get(id(r.currentApprover)) || short(r.currentApprover)}${activeOf.get(id(r.currentApprover)) === false ? ' [inactive]' : ''}`
        : null,
    });
  }

  // ---- Work-on-leave claims ---------------------------------------------
  // Not a ladder — one named approver, resolved by topLeaveApproverFor, whose
  // HR-Partner fallback was exactly what could name the employee themselves.
  const claims = await Attendance.find({ 'workOnLeave.status': 'Pending' })
    .select('employee date workOnLeave').lean();
  const claimRows = [];
  for (const a of claims) {
    const subject = userOf.get(id(a.employee));
    const approver = id(a.workOnLeave?.approver);
    let kind = null;
    if (approver && subject && approver === subject) kind = 'SELF';
    else if (!approver) kind = 'NO-ONE';
    else if (activeOf.get(approver) === false) kind = 'DEAD';
    if (!kind) continue;
    claimRows.push({
      kind,
      who: nameOf.get(subject) || `user ${short(subject)}`,
      code: codeOf.get(id(a.employee)),
      when: a.date ? new Date(a.date).toISOString().slice(0, 10) : '—',
      approver: approver ? (nameOf.get(approver) || short(approver)) : null,
    });
  }

  // ---- The root cause ----------------------------------------------------
  const selfPartnered = profiles
    .filter((p) => p.hrPartner && id(p.hrPartner) === id(p.user))
    .map((p) => `${nameOf.get(id(p.user)) || short(p.user)} (${p.employeeCode || '—'})`);

  console.log(`\nScanned ${leaves.length} pending leave, ${exits.length} pending exit, `
    + `${claims.length} pending work-on-leave.`);
  report('Leave requests:', leaveRows);
  report('Exit requests:', exitRows);
  report('Work-on-leave claims:', claimRows);

  console.log('\nEmployees who are their own HR Partner:');
  if (!selfPartnered.length) console.log('  none');
  else {
    selfPartnered.forEach((s) => console.log(`  ${s}`));
    console.log('  → clear or reassign hrPartner on these (SuperAdmin, Employees page).');
  }

  const stuck = [...leaveRows, ...exitRows, ...claimRows].filter((r) => r.kind !== 'SELF-RUNG');
  console.log(`\n${stuck.length} request(s) stuck right now.`);

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('check failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
