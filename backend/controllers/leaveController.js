const asyncHandler = require('express-async-handler');
const { LeaveRequest, LeaveBalance, LEAVE_TYPES } = require('../models/Leave');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { enqueueMail } = require('../services/email');
const { notify } = require('../services/notify');
const { daysInclusive, currentYear } = require('../utils/dateHelpers');

// Leave types that draw down from a tracked balance bucket
const BALANCED_TYPES = ['EL', 'CL', 'SL', 'ML'];

// Email the employee's HR partner (falling back to a SuperAdmin) about a new
// leave request. Reply-To is the applicant's address so the HR can reply to the
// employee directly. Best-effort — never blocks the leave application.
async function emailLeaveToHr(profile, request, applicant) {
  try {
    // Notify the reporting manager (who can now approve) and the HR partner,
    // falling back to a SuperAdmin if neither is set.
    const recipients = new Set();
    if (profile.reportingManager) {
      const mgr = await User.findById(profile.reportingManager).select('email');
      if (mgr?.email) recipients.add(mgr.email);
    }
    if (profile.hrPartner) {
      const hr = await User.findById(profile.hrPartner).select('email');
      if (hr?.email) recipients.add(hr.email);
    }
    if (recipients.size === 0) {
      const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('email');
      if (sa?.email) recipients.add(sa.email);
    }
    if (recipients.size === 0) return;

    const name = `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim() || 'An employee';
    const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const range = request.isHalfDay
      ? `${fmt(request.startDate)} (${request.halfDaySession === 'FirstHalf' ? '1st half' : '2nd half'})`
      : `${fmt(request.startDate)} – ${fmt(request.endDate)}`;

    await enqueueMail(
      {
        to: [...recipients],
        replyTo: applicant.email,
        subject: `Leave request from ${name} (${request.leaveType}, ${request.totalDays}d)`,
        text: [
          `${name} has applied for leave and needs your approval.`,
          '',
          `Type       : ${request.leaveType}`,
          `Dates      : ${range}`,
          `Total days : ${request.totalDays}`,
          `Reason     : ${request.reason || '—'}`,
          '',
          'Review and approve/reject it in the HRMS portal under Leave.',
          `Reply to this email to reach ${name} directly.`,
        ].join('\n'),
      },
      { type: 'leave', id: request._id }
    );
  } catch (err) {
    console.error('Leave HR email failed:', err.message);
  }
}

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

async function getOrCreateBalance(employeeId, year) {
  let balance = await LeaveBalance.findOne({ employee: employeeId, year });
  if (!balance) {
    balance = await LeaveBalance.create({ employee: employeeId, year });
  }
  return balance;
}

function adjustBalance(balance, leaveType, delta) {
  // delta > 0 → consume; delta < 0 → restore
  if (!BALANCED_TYPES.includes(leaveType)) return;
  const bucket = balance.balances[leaveType];
  if (!bucket) return;
  bucket.used = (bucket.used || 0) + delta;
  bucket.balance = (bucket.balance || 0) - delta;
}

// ===== Employee self-service =====

// GET /api/leave/me/balance?year=
const getMyBalance = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const year = Number(req.query.year) || currentYear();
  const balance = await getOrCreateBalance(profile._id, year);
  res.json({ balance });
});

// GET /api/leave/me/requests
const listMyRequests = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const requests = await LeaveRequest.find({ employee: profile._id })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

// POST /api/leave/me/requests
const applyForLeave = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const { leaveType, startDate, endDate, isHalfDay, halfDaySession, reason } = req.body;

  if (!leaveType || !startDate || !endDate) {
    res.status(400);
    throw new Error('leaveType, startDate, endDate are required');
  }
  if (!LEAVE_TYPES.includes(leaveType)) {
    res.status(400);
    throw new Error(`Invalid leaveType. Allowed: ${LEAVE_TYPES.join(', ')}`);
  }

  let totalDays;
  if (isHalfDay) {
    if (new Date(startDate).toDateString() !== new Date(endDate).toDateString()) {
      res.status(400);
      throw new Error('Half-day leave must have the same startDate and endDate');
    }
    if (!halfDaySession) {
      res.status(400);
      throw new Error('halfDaySession (FirstHalf|SecondHalf) is required for half-day leave');
    }
    totalDays = 0.5;
  } else {
    totalDays = daysInclusive(startDate, endDate);
    if (totalDays <= 0) {
      res.status(400);
      throw new Error('endDate must be on/after startDate');
    }
  }

  const request = await LeaveRequest.create({
    employee: profile._id,
    leaveType,
    startDate,
    endDate,
    isHalfDay: !!isHalfDay,
    halfDaySession,
    totalDays,
    reason,
  });

  // Notify the employee's HR (reply-to the employee). Best-effort.
  await emailLeaveToHr(profile, request, req.user);

  res.status(201).json({ request });
});

// PATCH /api/leave/me/requests/:id/cancel
const cancelMyRequest = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const request = await LeaveRequest.findOne({
    _id: req.params.id,
    employee: profile._id,
  });
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  if (request.status === 'Cancelled' || request.status === 'Rejected') {
    res.status(400);
    throw new Error(`Request is already ${request.status}`);
  }

  // If it was already approved, restore the balance
  if (request.status === 'Approved') {
    const year = new Date(request.startDate).getFullYear();
    const balance = await getOrCreateBalance(profile._id, year);
    adjustBalance(balance, request.leaveType, -request.totalDays);
    await balance.save();
  }

  request.status = 'Cancelled';
  request.decisionAt = new Date();
  await request.save();
  res.json({ request });
});

// ===== HR/Admin endpoints =====

// GET /api/leave/requests?employee=&status=&from=&to=
const listAllRequests = asyncHandler(async (req, res) => {
  const { employee, status, from, to } = req.query;
  const filter = {};
  if (employee) filter.employee = employee;
  if (status) filter.status = status;
  if (from || to) {
    filter.startDate = {};
    if (from) filter.startDate.$gte = new Date(from);
    if (to) filter.startDate.$lte = new Date(to);
  }
  const requests = await LeaveRequest.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

// Shared approve/reject core — used by HR/admin and by managers (for their
// direct reports). Mutates + saves the request; throws Error with a `.status`
// on a bad transition or insufficient balance. Caller loads/guards the request.
async function applyLeaveDecision(request, userId, action, note) {
  if (request.status !== 'Pending') {
    const err = new Error(`Cannot ${action} from status ${request.status}`);
    err.status = 400;
    throw err;
  }
  if (action === 'approve') {
    const year = new Date(request.startDate).getFullYear();
    const balance = await getOrCreateBalance(request.employee, year);
    if (BALANCED_TYPES.includes(request.leaveType)) {
      const available = balance.balances[request.leaveType]?.balance || 0;
      if (available < request.totalDays) {
        const err = new Error(`Insufficient ${request.leaveType} balance (have ${available}, need ${request.totalDays})`);
        err.status = 400;
        throw err;
      }
      adjustBalance(balance, request.leaveType, request.totalDays);
      await balance.save();
    }
    request.status = 'Approved';
  } else {
    request.status = 'Rejected';
  }
  request.approver = userId;
  request.decisionAt = new Date();
  request.decisionNote = note;
  await request.save();

  // Notify the applicant of the decision (in-app + push). Best-effort — a
  // notification failure must never undo a saved leave decision.
  try {
    const prof = await EmployeeProfile.findById(request.employee).select('user');
    if (prof?.user) {
      const approved = request.status === 'Approved';
      const days = `${request.totalDays} day${request.totalDays === 1 ? '' : 's'}`;
      await notify({
        recipient: prof.user,
        type: 'leave',
        title: approved ? 'Leave approved' : 'Leave rejected',
        body: `Your ${request.leaveType} leave (${days}) has been ${approved ? 'approved' : 'rejected'}.${note ? ` Note: ${note}` : ''}`,
        link: 'leave',
      });
    }
  } catch (err) {
    console.error('leave decision notify failed:', err.message);
  }

  return request;
}

// PATCH /api/leave/requests/:id/approve
const approveRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await applyLeaveDecision(request, req.user._id, 'approve', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// PATCH /api/leave/requests/:id/reject
const rejectRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await applyLeaveDecision(request, req.user._id, 'reject', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// GET /api/leave/balances?year= — list balances (admin)
const listBalances = asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || currentYear();
  const balances = await LeaveBalance.find({ year }).populate({
    path: 'employee',
    select: 'employeeCode user',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  res.json({ year, count: balances.length, balances });
});

// PUT /api/leave/balances/:employeeId/:year — upsert grant for an employee/year
const upsertBalance = asyncHandler(async (req, res) => {
  const { employeeId, year } = req.params;
  const profile = await EmployeeProfile.findById(employeeId);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  const balance = await getOrCreateBalance(profile._id, Number(year));
  const { balances } = req.body || {};
  if (balances) {
    for (const type of Object.keys(balances)) {
      if (!balance.balances[type]) continue;
      Object.assign(balance.balances[type], balances[type]);
      // Recompute balance for that bucket: opening + granted - used
      const b = balance.balances[type];
      b.balance =
        (b.opening || 0) + (b.granted || 0) - (b.used || 0) - (b.encashed || 0);
    }
  }
  await balance.save();
  res.json({ balance });
});

module.exports = {
  getMyBalance,
  listMyRequests,
  applyForLeave,
  cancelMyRequest,
  listAllRequests,
  approveRequest,
  rejectRequest,
  listBalances,
  upsertBalance,
  applyLeaveDecision,
};
