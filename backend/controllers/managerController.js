const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const { LeaveRequest } = require('../models/Leave');
const { applyLeaveDecision } = require('./leaveController');

// EmployeeProfile ids of the people who report directly to the current user.
async function myReportProfiles(userId) {
  return EmployeeProfile.find({ reportingManager: userId })
    .select('employeeCode designation department user')
    .populate('user', 'firstName lastName email photo')
    .lean();
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/manager/team — my direct reports with today's attendance snapshot.
const listTeam = asyncHandler(async (req, res) => {
  const reports = await myReportProfiles(req.user._id);
  const ids = reports.map((p) => p._id);

  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const todays = await Attendance.find({ employee: { $in: ids }, date: { $gte: today, $lt: tomorrow } }).lean();
  const byEmp = new Map(todays.map((a) => [String(a.employee), a]));

  const team = reports.map((p) => {
    const a = byEmp.get(String(p._id));
    return {
      profileId: p._id,
      userId: p.user?._id,
      name: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim(),
      hasPhoto: Boolean(p.user?.photo),
      employeeCode: p.employeeCode,
      designation: p.designation || '',
      department: p.department || '',
      today: a ? { status: a.status, checkIn: a.checkIn, checkOut: a.checkOut, hoursWorked: a.hoursWorked } : null,
    };
  });
  res.json({ count: team.length, team });
});

// GET /api/manager/leave-requests?status= — leave requests from my reports.
const listTeamLeave = asyncHandler(async (req, res) => {
  const reports = await myReportProfiles(req.user._id);
  const ids = reports.map((p) => p._id);
  const filter = { employee: { $in: ids } };
  if (req.query.status) filter.status = req.query.status;

  const requests = await LeaveRequest.find(filter)
    .populate({ path: 'employee', select: 'employeeCode user', populate: { path: 'user', select: 'firstName lastName email' } })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

// Load a leave request and confirm its employee reports to the current user.
async function loadTeamRequest(reqId, managerUserId, res) {
  const request = await LeaveRequest.findById(reqId);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  const profile = await EmployeeProfile.findById(request.employee).select('reportingManager');
  if (!profile || String(profile.reportingManager) !== String(managerUserId)) {
    res.status(403);
    throw new Error('You can only act on leave requests from your direct reports.');
  }
  return request;
}

// PATCH /api/manager/leave-requests/:id/approve
const approveTeamLeave = asyncHandler(async (req, res) => {
  const request = await loadTeamRequest(req.params.id, req.user._id, res);
  try {
    await applyLeaveDecision(request, req.user._id, 'approve', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// PATCH /api/manager/leave-requests/:id/reject
const rejectTeamLeave = asyncHandler(async (req, res) => {
  const request = await loadTeamRequest(req.params.id, req.user._id, res);
  try {
    await applyLeaveDecision(request, req.user._id, 'reject', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

module.exports = { listTeam, listTeamLeave, approveTeamLeave, rejectTeamLeave };
