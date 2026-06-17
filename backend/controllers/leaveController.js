const asyncHandler = require('express-async-handler');
const { LeaveRequest, LeaveBalance, LEAVE_TYPES } = require('../models/Leave');
const EmployeeProfile = require('../models/EmployeeProfile');
const { daysInclusive, currentYear } = require('../utils/dateHelpers');

// Leave types that draw down from a tracked balance bucket
const BALANCED_TYPES = ['EL', 'CL', 'SL', 'ML'];

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
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

// PATCH /api/leave/requests/:id/approve
const approveRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  if (request.status !== 'Pending') {
    res.status(400);
    throw new Error(`Cannot approve from status ${request.status}`);
  }

  const year = new Date(request.startDate).getFullYear();
  const balance = await getOrCreateBalance(request.employee, year);

  if (BALANCED_TYPES.includes(request.leaveType)) {
    const available = balance.balances[request.leaveType]?.balance || 0;
    if (available < request.totalDays) {
      res.status(400);
      throw new Error(
        `Insufficient ${request.leaveType} balance (have ${available}, need ${request.totalDays})`
      );
    }
    adjustBalance(balance, request.leaveType, request.totalDays);
    await balance.save();
  }

  request.status = 'Approved';
  request.approver = req.user._id;
  request.decisionAt = new Date();
  request.decisionNote = req.body.note;
  await request.save();
  res.json({ request });
});

// PATCH /api/leave/requests/:id/reject
const rejectRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  if (request.status !== 'Pending') {
    res.status(400);
    throw new Error(`Cannot reject from status ${request.status}`);
  }
  request.status = 'Rejected';
  request.approver = req.user._id;
  request.decisionAt = new Date();
  request.decisionNote = req.body.note;
  await request.save();
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
};
