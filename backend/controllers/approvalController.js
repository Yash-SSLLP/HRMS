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
const { advanceRegularizationApproval } = require('./regularizationController');
const { advanceApproval, ensureApprovalChain } = require('./leaveController');
const {
  advanceExitApproval,
  ensureExitApprovalChain,
  recordClearanceSection,
} = require('./exitController');

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
  const filter =
    scope === 'history'
      ? { 'approvalChain.approver': me }
      : { currentApprover: me, status: 'Pending' };
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
    await advanceApproval(request, req.user._id, 'approve', req.body.note);
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
    await advanceApproval(request, req.user._id, 'reject', req.body.note);
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
  const filter =
    scope === 'history'
      ? { 'approvalChain.approver': me }
      : { currentApprover: me, status: 'Pending' };
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
    await advanceExitApproval(request, req.user._id, 'approve', req.body.note);
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
    await advanceExitApproval(request, req.user._id, 'reject', req.body.note);
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
  const filter =
    scope === 'history'
      ? { 'clearanceSections.assignedTo': me }
      : { status: 'InClearance', clearanceSections: { $elemMatch: { assignedTo: me, completed: false } } };
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
  const filter =
    scope === 'history'
      ? { 'approvalChain.approver': me }
      : { currentApprover: me, status: 'Pending' };
  const requests = await Regularization.find(filter)
    .populate('employee', 'firstName lastName email role')
    .sort({ date: -1 })
    .lean();
  res.json({ scope, count: requests.length, requests });
});

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
  const [leave, exits, clearances, regularizations] = await Promise.all([
    LeaveRequest.countDocuments({ currentApprover: me, status: 'Pending' }),
    ExitRequest.countDocuments({ currentApprover: me, status: 'Pending' }),
    ExitRequest.countDocuments({
      status: 'InClearance',
      clearanceSections: { $elemMatch: { assignedTo: me, completed: false } },
    }),
    Regularization.countDocuments({ currentApprover: me, status: 'Pending' }),
  ]);
  res.json({
    leave,
    exits,
    clearances,
    regularizations,
    total: leave + exits + clearances + regularizations,
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
};
