/**
 * Reroute leave requests that are still PENDING onto the new approval rules.
 *
 *   node scripts/backfillLeaveHrRung.js               # report only, changes nothing
 *   node scripts/backfillLeaveHrRung.js --apply       # do it, and tell the people affected
 *   node scripts/backfillLeaveHrRung.js --apply --quiet   # do it silently (no notifications)
 *   node scripts/backfillLeaveHrRung.js --id <requestId>  # limit to one request
 *
 * WHY THIS EXISTS. Leave used to climb the reporting line to the first CEO/MD,
 * who gave the final approval; HR was only informed. That changed: HR is now the
 * LAST rung of every ladder, and an executive is TOLD the outcome instead of
 * being asked to sign it (controllers/leaveController.js → buildLeaveRouting).
 *
 * The new rules are applied when a request is RAISED, so every request already
 * in flight still carries the old ladder — it is sitting in an executive's inbox
 * and will finish without HR ever seeing it. This walks those and brings them
 * over.
 *
 * WHAT IT DOES NOT DO, deliberately:
 *
 *   - It does not touch Approved, Rejected or Cancelled requests. Those are
 *     history. Who signed a leave that has already been taken is a fact, not a
 *     configuration, and rewriting it would falsify the audit trail.
 *   - It does not rebuild the ladder from the CURRENT org chart. It edits the
 *     STORED chain in place: decided rungs are left exactly as they are,
 *     undecided CEO/MD rungs are removed, and HR is appended. Rebuilding from
 *     scratch would silently re-route a request to a different manager whenever
 *     somebody's reporting line had changed since they applied — a second,
 *     unasked-for change riding along with this one.
 *   - It never removes a rung somebody has already decided. An executive who has
 *     already approved stays in the chain as having approved, and is NOT added
 *     to execsToNotify: they acted, so telling them the outcome as though they
 *     had only been watching would be wrong.
 *   - It skips any request that would be left with NOBODY able to decide it.
 *     Those stay exactly as they are and are listed at the end, because the HR
 *     override is the right answer for them and it already works.
 *
 * WHY IT NOTIFIES BY DEFAULT. Moving a request off an executive's desk makes it
 * vanish from their inbox, and the HR person it lands on is told nothing. Left
 * silent, the request stalls where nobody is looking for it. So under --apply
 * the new approver is told it is theirs, and the executive is told it is off
 * their plate and that they will hear the outcome. Pass --quiet to suppress
 * that, e.g. when backfilling a restored database.
 *
 * Safe to run more than once: a request already carrying an HR rung and no
 * undecided executive is reported as "already correct" and left alone.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const LeaveRequest = require('../models/Leave');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { notify } = require('../services/notify');
const {
  hrApproverFor,
  NON_APPROVER_ROLES,
  leaveLabel,
} = require('../controllers/leaveController');

const APPLY = process.argv.includes('--apply');
const QUIET = process.argv.includes('--quiet');
const idFlag = process.argv.indexOf('--id');
const ONLY_ID = idFlag > -1 ? process.argv[idFlag + 1] : null;

const tag = APPLY ? '' : '[dry run] ';
const say = (msg) => console.log(`${tag}${msg}`);

// A rung nobody has ruled on yet. 'Skipped' is included: it means a lower rung
// rejected or an override voided it, neither of which can be true on a request
// that is still Pending, so a Skipped rung here is stale state worth rebuilding.
const UNDECIDED = new Set(['Pending', 'Waiting', 'Skipped']);
const isUndecided = (step) => UNDECIDED.has(step.status);
const isExec = (step) => NON_APPROVER_ROLES.includes(step.role);

const nameOf = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * Work out the new chain for one pending request without saving anything.
 * @param {Object} request - a Pending LeaveRequest document
 * @returns {Promise<Object>} a plan: { action, chain, execsToNotify, ... }
 */
async function planFor(request) {
  const chain = (request.approvalChain || []).map((s) => (s.toObject ? s.toObject() : { ...s }));

  const profile = await EmployeeProfile.findById(request.employee)
    .select('user reportingManager leaveApprovers hrPartner company employeeCode')
    .populate('user', 'firstName lastName');
  if (!profile) return { action: 'skip', reason: 'employee profile is missing' };

  const applicant = nameOf(profile.user) || 'An employee';
  const who = profile.employeeCode ? `${applicant} (${profile.employeeCode})` : applicant;

  // Everything already ruled on stays untouched — that is the audit trail.
  const decided = chain.filter((s) => !isUndecided(s));
  // ...and of what is left, an executive stops being an approver.
  const undecided = chain.filter(isUndecided);
  const droppedExecs = undecided.filter(isExec);
  const kept = undecided.filter((s) => !isExec(s));

  const next = [...decided, ...kept];

  // HR has the last word — the END of the ladder, not merely somewhere on it.
  // Three cases, and they are different:
  //   - not on the ladder       → append them
  //   - on it but undecided     → MOVE them to the end, so a manager above them
  //                               does not keep the final say
  //   - on it and already ruled → leave it exactly as it is. That decision
  //                               happened; re-ordering it would rewrite history
  //                               for the sake of a rule made afterwards.
  let hrAdded = null;
  let hrMoved = null;
  const hr = await hrApproverFor(profile);
  if (hr) {
    const at = next.findIndex((s) => String(s.approver) === String(hr.approver));
    if (at < 0) {
      hrAdded = hr;
      next.push({ ...hr, status: 'Waiting' });
    } else if (isUndecided(next[at])) {
      hrMoved = next[at];
      next.push(next.splice(at, 1)[0]);
    }
  }

  // Nobody left who can decide it: leave the request exactly as it is. The HR
  // override already handles this case and is a better answer than a chain we
  // invented.
  const stillUndecided = next.filter(isUndecided);
  if (!stillUndecided.length) {
    return {
      action: 'skip',
      reason: droppedExecs.length
        ? 'removing the executive would leave nobody to decide it, and no HR could be resolved'
        : 'no undecided rung and no HR could be resolved',
      who,
    };
  }

  next.forEach((s, i) => { s.order = i; });
  // The first undecided rung is whose turn it is; anything after it waits.
  let turnTaken = false;
  for (const s of next) {
    if (!isUndecided(s)) continue;
    s.status = turnTaken ? 'Waiting' : 'Pending';
    turnTaken = true;
  }
  const currentApprover = next.find((s) => s.status === 'Pending')?.approver || null;

  // Only executives who never got to decide are owed the outcome notice. One who
  // already approved acted on it, and is left in the chain as having done so.
  const execsToNotify = [...new Set([
    ...(request.execsToNotify || []).map(String),
    ...droppedExecs.filter((s) => s.approver).map((s) => String(s.approver)),
  ])];

  const wasApprover = request.currentApprover ? String(request.currentApprover) : null;
  const nowApprover = currentApprover ? String(currentApprover) : null;

  if (!droppedExecs.length && !hrAdded && !hrMoved && wasApprover === nowApprover) {
    return { action: 'ok', who };
  }

  return {
    action: 'update',
    who,
    chain: next,
    currentApprover,
    execsToNotify,
    droppedExecs,
    hrAdded,
    hrMoved,
    handoff: wasApprover !== nowApprover,
    profile,
    applicant,
  };
}

/**
 * Tell the people whose inbox just changed. Best-effort: a notification failure
 * must never leave a rerouted request half-migrated.
 */
async function announce(request, plan) {
  const span = new Date(request.startDate).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const subject = `${plan.applicant}'s ${leaveLabel(request.leaveType)} (${request.totalDays}d, from ${span})`;

  try {
    if (plan.currentApprover) {
      await notify({
        recipient: plan.currentApprover,
        type: 'leave',
        audience: 'admin',
        title: 'Leave request needs your approval',
        body: `${subject} is now waiting on you. Leave approval has moved to HR as the final step, `
          + 'so this request was re-routed from the reporting line.',
        link: 'approvals',
      });
    }
    for (const step of plan.droppedExecs) {
      if (!step.approver) continue;
      await notify({
        recipient: step.approver,
        type: 'leave',
        audience: 'admin',
        title: 'Leave approval moved to HR',
        body: `${subject} is no longer waiting on you — HR now gives the final approval on leave. `
          + 'You will be told the outcome once it is decided.',
        link: 'leave',
      });
    }
  } catch (err) {
    console.error(`  ! notify failed for ${request._id}: ${err.message}`);
  }
}

async function run() {
  await connectDB();

  const filter = { status: 'Pending' };
  if (ONLY_ID) filter._id = new mongoose.Types.ObjectId(ONLY_ID);
  const requests = await LeaveRequest.find(filter).sort({ appliedAt: 1 });

  console.log(`\n${requests.length} pending leave request(s) to consider.\n`);

  const updated = [];
  const skipped = [];
  let already = 0;

  for (const request of requests) {
    const plan = await planFor(request);

    if (plan.action === 'skip') {
      skipped.push({ id: String(request._id), who: plan.who, reason: plan.reason });
      continue;
    }
    if (plan.action === 'ok') { already += 1; continue; }

    const from = plan.droppedExecs.map((s) => `${s.approverName || 'exec'} (${s.role})`).join(', ');
    const to = plan.hrAdded
      ? `${plan.hrAdded.approverName} (${plan.hrAdded.role}) added last`
      : plan.hrMoved
        ? `${plan.hrMoved.approverName} moved to last`
        : 'already on the ladder';
    say(`${plan.who}: ${plan.droppedExecs.length ? `dropping ${from}; ` : ''}HR rung → ${to}`
      + `${plan.handoff ? '; it now waits on ' + (plan.chain.find((s) => s.status === 'Pending')?.approverName || '—') : ''}`);

    if (APPLY) {
      request.approvalChain = plan.chain;
      request.currentApprover = plan.currentApprover;
      request.execsToNotify = plan.execsToNotify;
      await request.save();
      if (!QUIET) await announce(request, plan);
    }
    updated.push({ id: String(request._id), who: plan.who });
  }

  console.log('');
  console.log(`  ${updated.length} request(s) ${APPLY ? 'rerouted' : 'would be rerouted'}`);
  console.log(`  ${already} already correct`);
  if (skipped.length) {
    console.log(`  ${skipped.length} left alone — decide these with the HR override on the Leave page:`);
    for (const s of skipped) console.log(`      ${s.id}  ${s.who || ''} — ${s.reason}`);
  }
  if (!APPLY && updated.length) {
    console.log('\n  Nothing was written. Re-run with --apply to make these changes.');
  }

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
