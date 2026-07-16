const asyncHandler = require('express-async-handler');
const { LeaveRequest } = require('../models/Leave');
const ExitRequest = require('../models/ExitRequest');
const { advanceApproval, ensureApprovalChain } = require('./leaveController');
const { advanceExitApproval, ensureExitApprovalChain } = require('./exitController');

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

module.exports = {
  listMyLeaveApprovals,
  approveLeave,
  rejectLeave,
  listMyExitApprovals,
  approveExit,
  rejectExit,
};
