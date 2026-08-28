/**
 * Approval controller — the approver's inbox for leave and resignation/exit
 * requests. Both climb a reporting-hierarchy approval chain (logic lives in
 * leaveController/exitController); this exposes list/approve/reject per approver
 * and self-heals Pending requests whose chain was never built.
 */
const asyncHandler = require('express-async-handler');
const { LeaveRequest } = require('../models/Leave');
const ExitRequest = require('../models/ExitRequest');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const { advanceRegularizationApproval } = require('./regularizationController');
const { listWorkOnLeaveClaims, decideWorkOnLeave } = require('./attendanceController');
const { advanceApproval, ensureApprovalChain } = require('./leaveController');
const {
  advanceExitApproval,
  ensureExitApprovalChain,
  recordClearanceSection,
} = require('./exitController');

/**
 * Does this account see EVERY inbox, not just its own rung?
 *
 * The Backend does. A ladder is a routing device — it says whose turn it is —
 * and routing must not decide what the person who administers the system is
 * allowed to know about. Before this, a request addressed to an HR Manager was
 * invisible to the SuperAdmin unless they went looking for it on the module's
 * own admin page, which is not where anyone looks for "what needs deciding".
 *
 * Deliberately SuperAdmin alone. An HR Manager or a CEO/MD still sees their own
 * rung: widening it for them would put every employee's leave in the inbox of
 * people who are not on those ladders for a reason.
 * @param {object|null} user
 * @returns {boolean}
 */
const seesAllApprovals = (user) => user?.role === 'SuperAdmin';

/**
 * The inbox filter for a chain-driven request type.
 * @param {object} user - the signed-in user
 * @param {string} scope - 'pending' | 'history'
 * @returns {Object} a Mongo filter
 */
function chainInboxFilter(user, scope) {
  const all = seesAllApprovals(user);
  if (scope === 'history') return all ? {} : { 'approvalChain.approver': user._id };
  return all ? { status: 'Pending' } : { currentApprover: user._id, status: 'Pending' };
}

// Rebuild the approval chain for any Pending request that has none yet (created
// before the hierarchy feature, or by an older backend). Runs on inbox load so
// stuck requests route to the right approver from the live org-chart hierarchy.
async function healOrphanChains() {
  const orphans = await LeaveRequest.find({
    status: 'Pending',
    $or: [{ currentApprover: null }, { currentApprover: { $exists: false } }],
    $and: [{ $or: [{ approvalChain: { $exists: false } }, { approvalChain: { $size: 0 } }] }],
  });
  for (const r of orphans) {
    try { await ensureApprovalChain(r); } catch (err) { console.error('heal chain failed:', err.message); }
  }
}

// Populate an approver-facing view of a leave request.
function populateLeave(query) {
  return query
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
}

/**
 * List leave requests for the current approver.
 * @route GET /api/approvals/leave?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (awaiting my decision) or 'history' (any request I'm in the chain of)
 * @returns {{scope, count, requests: Object[]}}
 * @sideeffect heals orphaned Pending chains on load
 */
// GET /api/approvals/leave?scope=pending|history
// pending  → requests awaiting MY decision right now (the action list).
// history  → every request I appear anywhere in the chain of, so a higher
//            approver (e.g. a CEO) can see one a lower manager already rejected.
const listMyLeaveApprovals = asyncHandler(async (req, res) => {
  await healOrphanChains();
  const me = req.user._id;
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const filter = chainInboxFilter(req.user, scope);
  const requests = await populateLeave(LeaveRequest.find(filter));
  res.json({ scope, count: requests.length, requests });
});

/**
 * Approve a leave request at the current chain step (may finalise or advance it).
 * @route PATCH /api/approvals/leave/:id/approve
 * @param {string} req.params.id - leave request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/leave/:id/approve
const approveLeave = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await advanceApproval(request, req.user._id, 'approve', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

/**
 * Reject a leave request at the current chain step.
 * @route PATCH /api/approvals/leave/:id/reject
 * @param {string} req.params.id - leave request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/leave/:id/reject
const rejectLeave = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await advanceApproval(request, req.user._id, 'reject', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// ================= Resignation / Exit approvals =================
// Same reporting-hierarchy ladder as leave, on the ExitRequest model. A fully
// approved resignation enters the notice period (status 'InClearance'); a
// rejection cancels it. See advanceExitApproval in exitController.

// Rebuild the chain for any Pending resignation that has none (created before
// this feature, or submitted with no manager). Runs on inbox load.
async function healExitOrphanChains() {
  const orphans = await ExitRequest.find({
    status: 'Pending',
    type: 'Resignation',
    $or: [{ currentApprover: null }, { currentApprover: { $exists: false } }],
    $and: [{ $or: [{ approvalChain: { $exists: false } }, { approvalChain: { $size: 0 } }] }],
  });
  for (const r of orphans) {
    try { await ensureExitApprovalChain(r); } catch (err) { console.error('heal exit chain failed:', err.message); }
  }
}

function populateExit(query) {
  return query
    .populate({
      path: 'employee',
      select: 'employeeCode user designation department',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('approver', 'firstName lastName role')
    .sort({ createdAt: -1 });
}

/**
 * List resignation/exit requests for the current approver.
 * @route GET /api/approvals/exits?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' or 'history'
 * @returns {{scope, count, requests: Object[]}}
 * @sideeffect heals orphaned Pending exit chains on load
 */
// GET /api/approvals/exits?scope=pending|history
const listMyExitApprovals = asyncHandler(async (req, res) => {
  await healExitOrphanChains();
  const me = req.user._id;
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const filter = chainInboxFilter(req.user, scope);
  const requests = await populateExit(ExitRequest.find(filter));
  res.json({ scope, count: requests.length, requests });
});

/**
 * Approve a resignation/exit at the current chain step (final approval starts the
 * notice period / InClearance).
 * @route PATCH /api/approvals/exits/:id/approve
 * @param {string} req.params.id - exit request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/exits/:id/approve
const approveExit = asyncHandler(async (req, res) => {
  const request = await ExitRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    await advanceExitApproval(request, req.user._id, 'approve', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

/**
 * Reject a resignation/exit at the current chain step (cancels it).
 * @route PATCH /api/approvals/exits/:id/reject
 * @param {string} req.params.id - exit request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/exits/:id/reject
const rejectExit = asyncHandler(async (req, res) => {
  const request = await ExitRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    await advanceExitApproval(request, req.user._id, 'reject', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// ================= No-dues clearance (assigned managers) =================
// A department manager (assigned per-exit by HR) ticks the no-dues section they
// own. Scoped to sections where `assignedTo === me`; the tick logic + guard live
// in exitController.recordClearanceSection.

/**
 * List exits with a no-dues section assigned to the current user.
 * @route GET /api/approvals/clearances?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (my section still open, InClearance) or 'history'
 * @returns {{scope, count, requests: Object[]}} exits populated with employee
 */
const listMyClearances = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  // Clearance sections are assigned per person rather than laddered, so the
  // Backend's "everything" view is every section still open, not only its own.
  const all = seesAllApprovals(req.user);
  const filter = scope === 'history'
    ? (all ? { clearanceSections: { $exists: true, $ne: [] } } : { 'clearanceSections.assignedTo': me })
    : {
      status: 'InClearance',
      clearanceSections: { $elemMatch: all ? { completed: false } : { assignedTo: me, completed: false } },
    };
  const requests = await ExitRequest.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user designation department',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ lastWorkingDay: 1 });
  res.json({ scope, count: requests.length, requests });
});

// ================= Attendance regularizations (configured ladder) =================
// Only requests whose employee has SuperAdmin-configured approvers reach here —
// an unconfigured one has no chain and stays on the flat HR-review path.

/**
 * List regularizations for the current approver.
 * @route GET /api/approvals/regularizations?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (awaiting me) or 'history' (any chain I'm in)
 * @returns {{scope, count, requests: Object[]}}
 */
const listMyRegularizationApprovals = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const filter = chainInboxFilter(req.user, scope);
  const requests = await Regularization.find(filter)
    .populate('employee', 'firstName lastName email role')
    .sort({ date: -1 })
    .lean();

  // Attach the day's CURRENT punches so the approver sees "from → to" rather
  // than only the value being asked for. previousCheckIn/Out on the request
  // itself are no help here: applyToAttendance fills those at approval time, so
  // a pending request has them empty — which is exactly when the approver needs
  // to know what is being changed.
  const withCurrent = await attachCurrentPunches(requests);
  res.json({ scope, count: withCurrent.length, requests: withCurrent });
});

/**
 * Look up the attendance record behind each regularization and hang the current
 * punches off it as `current: { checkIn, checkOut, status }`.
 *
 * Regularization.employee refs User while Attendance.employee refs
 * EmployeeProfile, so this hops through the profile. Two queries for the whole
 * page rather than one per row; a day with no record simply comes back null.
 * @param {Object[]} requests - lean Regularization docs
 * @returns {Promise<Object[]>} the same docs, each with `current`
 */
async function attachCurrentPunches(requests) {
  if (!requests.length) return requests;
  const EmployeeProfile = require('../models/EmployeeProfile');
  const Attendance = require('../models/Attendance');
  const { startOfDayIST } = require('../utils/dateHelpers');

  const userIds = [...new Set(requests.map((r) => String(r.employee?._id || r.employee)).filter(Boolean))];
  const profiles = await EmployeeProfile.find({ user: { $in: userIds } }).select('user').lean();
  const profByUser = new Map(profiles.map((p) => [String(p.user), String(p._id)]));

  const pairs = requests
    .map((r) => ({
      profileId: profByUser.get(String(r.employee?._id || r.employee)),
      day: startOfDayIST(r.date),
    }))
    .filter((p) => p.profileId);
  // An empty $or is a Mongo error, so bail before building the query.
  if (!pairs.length) return requests.map((r) => ({ ...r, current: null }));

  const records = await Attendance.find({
    $or: pairs.map((p) => ({ employee: p.profileId, date: p.day })),
  }).select('employee date checkIn checkOut status').lean();

  const key = (empId, day) => `${empId}|${new Date(day).getTime()}`;
  const byKey = new Map(records.map((a) => [key(String(a.employee), a.date), a]));

  return requests.map((r) => {
    const profileId = profByUser.get(String(r.employee?._id || r.employee));
    const found = profileId ? byKey.get(key(profileId, startOfDayIST(r.date))) : null;
    return {
      ...r,
      current: found
        ? { checkIn: found.checkIn || null, checkOut: found.checkOut || null, status: found.status || null }
        : null,
    };
  });
}

// Shared by the approve/reject routes below — both are the same call with a
// different action, and both are scoped to `currentApprover === me` inside
// advanceRegularizationApproval.
const decideRegularization = (action) =>
  asyncHandler(async (req, res) => {
    const item = await Regularization.findById(req.params.id);
    if (!item) {
      res.status(404);
      throw new Error('Regularization request not found');
    }
    try {
      const out = await advanceRegularizationApproval(
        item, req.user._id, action, req.body.note, req.user
      );
      res.json(out);
    } catch (err) {
      res.status(err.status || 400);
      throw err;
    }
  });

/**
 * Approve a regularization at the current chain step (may advance or finalise+apply).
 * @route PATCH /api/approvals/regularizations/:id/approve
 */
const approveRegularization = decideRegularization('approve');

/**
 * Reject a regularization at the current chain step (stops the chain).
 * @route PATCH /api/approvals/regularizations/:id/reject
 */
const rejectRegularization = decideRegularization('reject');

// ============ Work on a leave day (punched in while on approved leave) ============
// Not a ladder: the whole leave hierarchy already granted the leave, so only its
// TOP rung rules on whether working through it counts. The claim lives on the
// attendance record itself (Attendance.workOnLeave), so these are days, not
// requests. Scoping is `workOnLeave.approver === me`, enforced again inside
// decideWorkOnLeave, which also honours an HR (`leave.manage`) override.

/**
 * List work-on-leave claims for the current approver.
 * @route GET /api/approvals/work-on-leave?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (awaiting me) or 'history' (every claim routed to me)
 * @returns {{scope, count, claims: Object[]}}
 */
const listMyWorkOnLeave = asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const claims = await listWorkOnLeaveClaims(req.user._id, scope, seesAllApprovals(req.user));
  res.json({ scope, count: claims.length, claims });
});

// Shared by the approve/reject routes — the same call with a different action.
const decideWorkOnLeaveRoute = (action) =>
  asyncHandler(async (req, res) => {
    const record = await Attendance.findById(req.params.id);
    if (!record) {
      res.status(404);
      throw new Error('Attendance record not found');
    }
    try {
      const out = await decideWorkOnLeave(record, req.user._id, action, req.body.note, req.user);
      res.json({ record: out.record, leaveDayReturned: out.leaveDayReturned });
    } catch (err) {
      res.status(err.status || 400);
      throw err;
    }
  });

/**
 * Approve a punch-in made on an approved-leave day: the leave day is returned
 * and the day becomes a worked day.
 * @route PATCH /api/approvals/work-on-leave/:id/approve
 */
const approveWorkOnLeave = decideWorkOnLeaveRoute('approve');

/**
 * Reject it: the punches stay on the record, the day stays leave.
 * @route PATCH /api/approvals/work-on-leave/:id/reject
 */
const rejectWorkOnLeave = decideWorkOnLeaveRoute('reject');

/**
 * How many items are waiting on the current user, for the top-bar shortcut badge.
 *
 * Deliberately cheap — three countDocuments, no populate and no chain healing —
 * because every logged-in user's top bar polls this on a timer, whereas the list
 * endpoints above each run healOrphanChains() and fully populate their results.
 * The trade-off: a legacy request whose chain was never built (currentApprover
 * null) is not counted here until an inbox load heals it.
 * @route GET /api/approvals/count
 * @returns {{leave: number, exits: number, clearances: number, total: number}}
 */
const countMyApprovals = asyncHandler(async (req, res) => {
  const me = req.user._id;
  // The badge has to agree with the lists above, or the Backend sees a count of
  // 3 and opens an inbox holding 11.
  const all = seesAllApprovals(req.user);
  const mine = all ? {} : { currentApprover: me };
  const section = all ? { completed: false } : { assignedTo: me, completed: false };
  const [leave, exits, clearances, regularizations, workOnLeave] = await Promise.all([
    LeaveRequest.countDocuments({ ...mine, status: 'Pending' }),
    ExitRequest.countDocuments({ ...mine, status: 'Pending' }),
    ExitRequest.countDocuments({
      status: 'InClearance',
      clearanceSections: { $elemMatch: section },
    }),
    Regularization.countDocuments({ ...mine, status: 'Pending' }),
    Attendance.countDocuments({
      ...(all ? {} : { 'workOnLeave.approver': me }), 'workOnLeave.status': 'Pending',
    }),
  ]);
  res.json({
    leave,
    exits,
    clearances,
    regularizations,
    workOnLeave,
    total: leave + exits + clearances + regularizations + workOnLeave,
  });
});

/**
 * The assigned manager ticks their no-dues section.
 * @route PATCH /api/approvals/clearances/:id/:key
 * @param {Object} req.body.items - array of { done, note } by item index
 * @returns {{request: Object}}
 */
const updateMyClearanceSection = asyncHandler(async (req, res) => {
  const request = await ExitRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    // privileged=false → the actor must be the section's assignee.
    await recordClearanceSection(request, req.params.key, req.user._id, false, req.body);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

module.exports = {
  listMyLeaveApprovals,
  approveLeave,
  rejectLeave,
  listMyExitApprovals,
  approveExit,
  rejectExit,
  listMyClearances,
  updateMyClearanceSection,
  countMyApprovals,
  listMyRegularizationApprovals,
  approveRegularization,
  rejectRegularization,
  listMyWorkOnLeave,
  approveWorkOnLeave,
  rejectWorkOnLeave,
};
