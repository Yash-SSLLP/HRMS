const asyncHandler = require('express-async-handler');
const { LeaveRequest } = require('../models/Leave');
const { advanceApproval } = require('./leaveController');

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

module.exports = { listMyLeaveApprovals, approveLeave, rejectLeave };
