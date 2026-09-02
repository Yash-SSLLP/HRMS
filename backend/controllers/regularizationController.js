/**
 * Regularization controller — attendance-correction requests. Employees raise
 * requests to fix a day's check-in/out; HR approve/reject, and an approval APPLIES
 * the corrected times straight onto the day's Attendance record (recording a
 * before/after snapshot). HR can also regularize any employee's day directly.
 */
const asyncHandler = require('express-async-handler');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { notify, notifyBackend } = require('../services/notify');
const { isReadOnlyExec } = require('../middleware/authMiddleware');
const { scopeUserField } = require('../utils/employeeScope');
const { startOfDayIST } = require('../utils/dateHelpers');
const { settleStatus } = require('../utils/workday');

// `role` rides along so the review screen can tell an HR's own request apart
// from an ordinary employee's (see HR_REVIEW_ROLES below).
const EMPLOYEE_FIELDS = 'firstName lastName email role';

// The day and the punches, written the way the employee reads them everywhere
// else in the portal: "14 Aug 2026", and 12-hour times with a meridiem. Node's
// en-IN emits a lowercase "pm" where the browser emits "PM", so it is upper-cased
// to match the rest of the UI.
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
const fmtTime = (d) => (d
  ? new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
    .replace(/\b([ap])\.?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`)
  : null);

/**
 * The body of the decision notification.
 *
 * On approval this names the times the day now carries, taken from what was
 * actually written to the attendance record rather than from what was asked for
 * — if applying the correction partly failed, the message must not claim a
 * change that did not land. With neither punch available it falls back to a
 * plain confirmation.
 *
 * @param {Object} item the decided Regularization document
 * @param {'Approved'|'Rejected'} status
 * @param {string} [reviewNote]
 * @returns {string}
 */
function regularizationOutcome(item, status, reviewNote) {
  const day = fmtDay(item.date);
  const note = reviewNote ? ` Note: ${reviewNote}` : '';
  if (status !== 'Approved') {
    return `${day} was not changed, so the day stands as recorded.${note}`;
  }
  const parts = [];
  const inAt = fmtTime(item.appliedCheckIn);
  const outAt = fmtTime(item.appliedCheckOut);
  if (inAt) parts.push(`in ${inAt}`);
  if (outAt) parts.push(`out ${outAt}`);
  return parts.length
    ? `${day} now reads ${parts.join(', ')}.${note}`
    : `${day} has been corrected on your attendance.${note}`;
}

// HR review their own colleagues' attendance, so an HR's OWN regularization
// cannot be decided by HR — it goes up to an executive or a SuperAdmin. CEO/MD
// are read-only everywhere else; this route is a deliberate exception, the same
// shape as their existing role as reporting-chain leave approvers.
const HR_REVIEW_ROLES = ['SuperAdmin', 'CEO', 'MD'];
const HR_ROLE = 'HRManager';

/**
 * Build the configured approval ladder for an employee's regularization.
 *
 * Unlike leave, this is NOT derived from the org chart — a SuperAdmin names the
 * approvers per employee (EmployeeProfile.regularizationApprovers), because an
 * attendance correction is often signed off by a shift or ops lead rather than
 * the employee's reporting manager. 1 rung minimum, 2 maximum.
 *
 * Inactive approvers and the requester themselves are dropped (nobody signs off
 * their own attendance correction). An empty result is normal and meaningful:
 * it means "not configured", and the caller keeps the flat HR-review path.
 * @param {mongoose.Types.ObjectId} employeeUserId - the requester's User id
 * @returns {Promise<Object[]>} rungs shaped like approvalStepSchema
 */
async function buildRegularizationChain(employeeUserId) {
  const profile = await EmployeeProfile.findOne({ user: employeeUserId })
    .select('regularizationApprovers')
    .lean();
  const configured = (profile?.regularizationApprovers || []).slice(0, 2);
  if (!configured.length) return [];

  const chain = [];
  const seen = new Set([String(employeeUserId)]);
  for (const id of configured) {
    const key = String(id);
    if (seen.has(key)) continue; // no self-approval, no duplicate rung
    seen.add(key);
    const u = await User.findById(id).select('firstName lastName role isActive').lean();
    if (!u || u.isActive === false) continue;
    chain.push({
      approver: u._id,
      approverName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      role: u.role,
      order: chain.length,
      status: 'Waiting',
    });
  }
  return chain;
}

// Tell the person whose turn it is. Best-effort — a failed notification must
// never stop the request being filed or advanced.
async function notifyRegApprover(approverUserId, item, applicantName) {
  try {
    await notify({
      recipient: approverUserId,
      type: 'regularization',
      audience: 'admin',
      title: 'Regularization needs your approval',
      body: `${applicantName} raised an attendance regularization (${item.type}) - it's awaiting your approval.`,
      link: 'regularizations',
    });
  } catch (err) {
    console.error('regularization approver notify failed:', err.message);
  }
}

// Tell the employee a rung decided, mirroring the leave hierarchy: they hear
// about every step, not just the final outcome.
async function notifyRegEmployeeStep(item, step, next, note) {
  try {
    const total = (item.approvalChain || []).length;
    const stepNo = (step?.order ?? 0) + 1;
    await notify({
      recipient: item.employee,
      type: 'regularization',
      audience: 'employee',
      title: `Regularization approved at step ${stepNo} of ${total}`,
      body: `${step?.approverName || 'Your approver'} approved your ${item.type} regularization. It now needs ${next?.approverName || 'the next approver'}'s approval.${note ? ` Note: ${note}` : ''}`,
      link: 'regularizations',
    });
  } catch (err) {
    console.error('regularization step notify failed:', err.message);
  }
}

// Final outcome for the employee.
async function notifyRegEmployeeDecision(item, note) {
  try {
    const approved = item.status === 'Approved';
    await notify({
      recipient: item.employee,
      type: 'regularization',
      audience: 'employee',
      title: `Regularization ${approved ? 'approved' : 'rejected'}`,
      body: `Your ${item.type} regularization has been ${approved ? 'approved' : 'rejected'}.${note ? ` Note: ${note}` : ''}`,
      link: 'regularizations',
    });
  } catch (err) {
    console.error('regularization decision notify failed:', err.message);
  }
}

// 'HH:mm' (or a full date string) + the request's day → a concrete Date on
// that IST day. Returns undefined when the value is empty/unparseable.
function timeOnDay(day, value) {
  if (!value) return undefined;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    return new Date(startOfDayIST(day).getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Apply an approved regularization to the employee's Attendance record for
// that day (creating the record if the day has none). Filling a check-out
// clears any "no punch-out" mark via the Attendance pre-save hook.
async function applyToAttendance(item, reviewer) {
  const profile = await EmployeeProfile.findOne({ user: item.employee });
  if (!profile) throw new Error('No employee profile linked to this user');

  const day = startOfDayIST(item.date);
  let record = await Attendance.findOne({ employee: profile._id, date: day });
  const isNew = !record;
  // Snapshot the BEFORE state so the audit view can show "from → to".
  const prevStatus = isNew ? 'No record' : record.status;
  const prevIn = isNew ? null : record.checkIn;
  const prevOut = isNew ? null : record.checkOut;
  if (!record) {
    record = new Attendance({ employee: profile._id, date: day, status: 'Present' });
  }
  const inAt = timeOnDay(item.date, item.requestedCheckIn);
  let outAt = timeOnDay(item.date, item.requestedCheckOut);
  if (inAt) record.checkIn = inAt;
  // A 'Forgot Check-out' request carries only a time-of-day, and timeOnDay can
  // only anchor it to the request's OWN day — so a shift that ended after
  // midnight ("00:15") resolves to 00:15 that morning, hours BEFORE the check-in.
  // Left alone the pair inverts, effectiveHours collapses the negative span to 0,
  // and the day-minimum rule reads that as a zero-hour day and charges a full
  // day's pay for a shift that actually ran ten hours. Roll it forward to the
  // next day instead, which is what an after-midnight close means.
  //
  // The sibling HR-edit path already refuses an inverted pair outright
  // (updateRecord: "Check-out has to be after check-in."); this is the path
  // employees are actually pointed at, so it had no such protection at all.
  const effectiveIn = inAt || record.checkIn;
  if (outAt && effectiveIn && outAt.getTime() <= new Date(effectiveIn).getTime()) {
    outAt = new Date(outAt.getTime() + 24 * 60 * 60 * 1000);
  }
  if (outAt) record.checkOut = outAt;
  if (record.checkIn && record.status === 'Absent') record.status = 'Present';
  // Re-derive the day from the corrected punches. This is what "half day until
  // regularization" means: a day auto-halved for short hours (or for a missing
  // punch-out counted to 7 PM) is restored to Present once the real times show
  // a full day — and stays a half day if they don't.
  record.status = settleStatus(record) || record.status;
  const note = `Regularized (${item.type}) by ${reviewer?.fullName || 'HR'}: ${item.reason}`;
  record.remarks = record.remarks ? `${record.remarks} · ${note}` : note;
  await record.save();

  // Persist the before/after on the regularization for oversight (best-effort).
  item.previousStatus = prevStatus;
  item.previousCheckIn = prevIn || undefined;
  item.previousCheckOut = prevOut || undefined;
  item.appliedCheckIn = record.checkIn;
  item.appliedCheckOut = record.checkOut;
  try { await item.save(); } catch (err) { console.error('Regularization audit save failed:', err.message); }
  return record;
}

/**
 * List the caller's own regularization requests, newest first.
 * @route GET /api/regularizations/me
 * @returns {{count: number, items: Object[]}}
 */
// GET /api/regularizations/me  — the caller's own requests
const listMine = asyncHandler(async (req, res) => {
  const items = await Regularization.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

/**
 * Employee raises a regularization request (status Pending).
 * @route POST /api/regularizations
 * @param {string} req.body.date - required
 * @param {string} req.body.reason - required
 * @param {string} [req.body.type]
 * @param {string} [req.body.requestedCheckIn] - 'HH:mm' or date string
 * @param {string} [req.body.requestedCheckOut] - 'HH:mm' or date string
 * @returns {{item: Object}} (201)
 */
// POST /api/regularizations  { date, type, requestedCheckIn, requestedCheckOut, reason }
const createRequest = asyncHandler(async (req, res) => {
  const { date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;

  if (!date || !reason) {
    res.status(400);
    throw new Error('date and reason are required');
  }

  // A configured ladder routes the request to named approvers; with none
  // configured it stays on the flat "any HR reviewer" path it has always used.
  const chain = await buildRegularizationChain(req.user._id);
  if (chain.length) chain[0].status = 'Pending';

  const item = await Regularization.create({
    employee: req.user._id,
    date,
    type,
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Pending',
    approvalChain: chain,
    currentApprover: chain.length ? chain[0].approver : null,
  });

  const name = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'An employee';
  if (chain.length) {
    await notifyRegApprover(chain[0].approver, item, name);
  }
  // Unconditional: with no configured approver the request falls to the flat HR
  // path, which told NOBODY it had arrived.
  await notifyBackend({
    type: 'regularization',
    title: 'New regularization request',
    body: `${name} raised a ${item.type} regularization for ${fmtDay(item.date)}.`,
    link: 'approvals',
    exclude: [chain.length ? chain[0].approver : null, item.employee],
  });

  res.status(201).json({ item });
});

/**
 * List all regularization requests, optionally filtered by status (admin).
 * @route GET /api/regularizations  (admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, items: Object[]}} with populated employee/reviewedBy
 */
// GET /api/regularizations  (admin) — optional ?status filter
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  // Company wall: only requests from employees this admin may see
  // (Regularization.employee is a User id). No-op for unrestricted viewers.
  await scopeUserField(req, filter);

  const items = await Regularization.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .populate('reviewedBy', 'firstName lastName role') // who did the regularization
    .sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

/**
 * Approve or reject a request; approval applies the fix to the Attendance record.
 * @route PATCH /api/regularizations/:id/status  (admin)
 * @param {string} req.params.id - request id
 * @param {string} req.body.status - 'Approved' or 'Rejected'
 * @param {string} [req.body.reviewNote]
 * @returns {{item: Object, applied: boolean}}
 * @sideeffect on approval writes to Attendance; notifies the employee either way
 */
// PATCH /api/regularizations/:id/status  (admin)  { status, reviewNote }
// Approving now also APPLIES the requested times to the day's Attendance
// record, so the fix is visible everywhere immediately.
// The requester's display name, for approver-facing notifications. Never throws:
// it is called as an argument to the notify helpers, i.e. OUTSIDE their own
// try/catch, and the request has already been saved by then — a lookup failure
// must not turn a completed approval into a 500.
async function applicantNameOf(userId) {
  try {
    const u = await User.findById(userId).select('firstName lastName').lean();
    return `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'An employee';
  } catch {
    return 'An employee';
  }
}

/**
 * Configured-ladder decision — the normal path once a SuperAdmin has named
 * approvers. The acting user MUST be the current approver, so an ordinary
 * employee named as an approver can decide without holding attendance.manage.
 *
 * Approve → advance to the next rung, or, on the LAST rung, finalize and apply
 * the correction to the attendance record. Reject → stop the chain immediately.
 * The apply deliberately fires only at the end: a 2-step request must not touch
 * attendance after step 1.
 * @param {Object} item - the Regularization doc (mutated + saved)
 * @param {*} userId - the acting approver
 * @param {'approve'|'reject'} action
 * @param {string} [note]
 * @param {Object} [actor] - req.user, used to attribute the attendance remark
 * @returns {Promise<{item: Object, applied: boolean}>}
 * @throws {Error} with `.status` on a bad transition
 */
async function advanceRegularizationApproval(item, userId, action, note, actor) {
  if (item.status !== 'Pending') {
    const err = new Error(`Cannot ${action} - this request is ${item.status}.`);
    err.status = 400;
    throw err;
  }
  // The Backend decides anything, from anywhere — the same override it already
  // had from the Regularizations page, now reachable from the approvals inbox
  // where the request is actually visible to it.
  const override = !item.currentApprover || String(item.currentApprover) !== String(userId);
  if (override && !(actor && actor.role === 'SuperAdmin')) {
    const err = new Error('This regularization is not awaiting your approval.');
    err.status = 403;
    throw err;
  }
  // Belt and braces: the chain builder already refuses to add the requester.
  if (String(item.employee) === String(userId)) {
    const err = new Error('You cannot review your own regularization request.');
    err.status = 403;
    throw err;
  }

  const now = new Date();
  const step = (item.approvalChain || []).find(
    (s) => String(s.approver) === String(userId) && s.status === 'Pending'
  );

  // Void the rungs that never got their turn and tell them it is off their
  // plate. With no Waiting rung left, the flow below takes the last-rung path
  // and the correction is applied — matching what the Regularizations page does.
  if (override) {
    const overridden = (item.approvalChain || []).filter(
      (st) => st.status === 'Pending' || st.status === 'Waiting'
    );
    for (const st of overridden) st.status = 'Skipped';
    if (overridden.length) {
      try {
        const { notifyMany } = require('../services/notify');
        const who = await applicantNameOf(item.employee);
        await notifyMany(overridden.map((st) => st.approver).filter(Boolean), {
          type: 'regularization',
          audience: 'admin',
          title: `Regularization ${action === 'approve' ? 'approved' : 'rejected'} by the Backend`,
          body: `${who}'s ${item.type} regularization was decided by a Super Admin - no action is needed from you.`,
          link: 'regularizations',
        });
      } catch (err) {
        console.error('regularization override notify failed:', err.message);
      }
    }
  }

  if (action === 'reject') {
    if (step) { step.status = 'Rejected'; step.decidedAt = now; step.note = note; }
    for (const s of item.approvalChain || []) {
      if (s.status === 'Waiting') s.status = 'Skipped';
    }
    item.status = 'Rejected';
    item.currentApprover = null;
    item.reviewedBy = userId;
    item.reviewedAt = now;
    item.reviewNote = note;
    await item.save();
    await notifyRegEmployeeDecision(item, note);
    return { item, applied: false };
  }

  const next = (item.approvalChain || []).find(
    (s) => s.status === 'Waiting' && (!step || s.order > step.order)
  );
  if (next) {
    if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
    next.status = 'Pending';
    item.currentApprover = next.approver;
    await item.save();
    await notifyRegApprover(next.approver, item, await applicantNameOf(item.employee));
    await notifyRegEmployeeStep(item, step, next, note);
    return { item, applied: false };
  }

  // Last rung — the correction takes effect now.
  if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
  item.status = 'Approved';
  item.currentApprover = null;
  item.reviewedBy = userId;
  item.reviewedAt = now;
  item.reviewNote = note;
  await item.save();
  let applied = null;
  try {
    applied = await applyToAttendance(item, actor);
  } catch (err) {
    // Same rule as the HR path: the decision stands even if applying fails.
    console.error('Regularization apply failed:', err.message);
  }
  await notifyRegEmployeeDecision(item, note);
  return { item, applied: !!applied };
}

const reviewRequest = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;

  if (!['Approved', 'Rejected'].includes(status)) {
    res.status(400);
    throw new Error('status must be Approved or Rejected');
  }

  const item = await Regularization.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Regularization request not found');
  }

  // Nobody signs off their own attendance correction, whatever their role.
  if (String(item.employee) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot review your own regularization request.');
  }

  // An HR's own request needs an executive or a SuperAdmin — HR reviewing HR
  // (each other's, or their own via a colleague) would defeat the control.
  const requester = await User.findById(item.employee).select('role');
  if (requester?.role === HR_ROLE && !HR_REVIEW_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error('An HR regularization can only be approved by the CEO, MD or a Super Admin.');
  }
  // …and the exception goes no further: a VIEW-ONLY exec's write access here
  // covers HR requests only. Everyone else's still belongs to HR, so they stay
  // read-only on those, as on every other admin screen. (An exec a SuperAdmin
  // has put in edit mode decides any request, like HR.)
  if (isReadOnlyExec(req.user) && requester?.role !== HR_ROLE) {
    res.status(403);
    throw new Error('CEO/MD accounts review HR regularizations only; this one is for HR to decide.');
  }

  // HR deciding a request that has a configured ladder is an OVERRIDE: void the
  // rungs that never got their turn and tell those approvers it is off their
  // plate, so it can't sit in their inbox as a ghost. (Mirrors the leave
  // override valve — HR keeps a way to unstick a request whose named approver
  // is unavailable.)
  const overridden = (item.approvalChain || []).filter(
    (s) => s.status === 'Pending' || s.status === 'Waiting'
  );
  for (const s of overridden) s.status = 'Skipped';
  item.currentApprover = null;

  item.status = status;
  item.reviewNote = reviewNote;
  item.reviewedBy = req.user._id;
  item.reviewedAt = new Date();
  await item.save();

  if (overridden.length) {
    const name = await applicantNameOf(item.employee);
    try {
      const { notifyMany } = require('../services/notify');
      await notifyMany(
        overridden.map((s) => s.approver).filter(Boolean),
        {
          type: 'regularization',
          audience: 'admin',
          title: `Regularization ${status.toLowerCase()} by HR`,
          body: `${name}'s ${item.type} regularization was ${status.toLowerCase()} by HR - no action is needed from you.`,
          link: 'regularizations',
        }
      );
    } catch (err) {
      console.error('regularization override notify failed:', err.message);
    }
  }

  let applied = null;
  if (status === 'Approved') {
    try {
      applied = await applyToAttendance(item, req.user);
    } catch (err) {
      // The decision stands even if applying fails (e.g. no profile) — HR can
      // still fix the record manually from the attendance views.
      console.error('Regularization apply failed:', err.message);
    }
  }

  notify({
    recipient: item.employee,
    type: 'regularization',
    audience: 'employee',
    title: status === 'Approved' ? 'Attendance corrected' : 'Regularization not approved',
    // Say what actually changed, not just that something did. "Your request was
    // approved" leaves the employee to go and look up what their day now reads
    // as; the corrected punches are the whole point of the request, so they
    // belong in the line they are already reading.
    body: regularizationOutcome(item, status, reviewNote),
    link: 'regularizations',
  }).catch(() => {});

  res.json({ item, applied: !!applied });
});

/**
 * HR regularizes any employee's day directly (recorded pre-Approved and applied).
 * @route POST /api/regularizations/admin  (admin)
 * @param {string} req.body.employee - target user id (required)
 * @param {string} req.body.date - required
 * @param {string} req.body.reason - required
 * @param {string} [req.body.type='Other']
 * @param {string} [req.body.requestedCheckIn]
 * @param {string} [req.body.requestedCheckOut]
 * @returns {{item: Object, record: Object}} (201)
 * @sideeffect writes to the day's Attendance record; notifies the employee
 */
// POST /api/regularizations/admin  (admin)
// { employee (User id), date, type, requestedCheckIn, requestedCheckOut, reason }
// HR regularizes any employee's attendance directly: the request is recorded
// as already Approved (for the audit trail) and applied to the day's record.
const adminCreate = asyncHandler(async (req, res) => {
  const { employee, date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;
  if (!employee || !date || !reason) {
    res.status(400);
    throw new Error('employee, date and reason are required');
  }

  // A direct regularization is self-approved by definition, so HR must not be
  // able to aim it at an HR (themselves or a colleague) — that would walk
  // straight around the review rule in reviewRequest above. They raise a
  // request instead, and an executive or SuperAdmin decides it.
  const target = await User.findById(employee).select('role');
  if (target?.role === HR_ROLE && !HR_REVIEW_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error(
      String(employee) === String(req.user._id)
        ? 'You cannot regularize your own attendance. Raise a request for the CEO, MD or a Super Admin to approve.'
        : "An HR's attendance can only be regularized by the CEO, MD or a Super Admin.",
    );
  }

  const item = await Regularization.create({
    employee,
    date,
    type: type || 'Other',
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Approved',
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
    reviewNote: 'Regularized directly by HR',
  });

  const record = await applyToAttendance(item, req.user);

  notify({
    recipient: employee,
    type: 'regularization',
    audience: 'employee',
    title: 'Your attendance was regularized',
    body: `HR updated your attendance for ${new Date(date).toLocaleDateString('en-IN', { dateStyle: 'medium' })}: ${reason}`,
    link: 'attendance',
  }).catch(() => {});

  res.status(201).json({ item, record });
});

module.exports = {
  listMine, createRequest, listAll, reviewRequest, adminCreate,
  // Used by the shared approvals inbox (controllers/approvalController.js).
  advanceRegularizationApproval,
};
