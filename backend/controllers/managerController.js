/**
 * Manager controller — team-scoped self-service for a reporting manager (queries
 * are limited to their direct reports via EmployeeProfile.reportingManager).
 * Exposes team roster with today's attendance, a presence board, team leave
 * requests plus hierarchy-aware approve/reject, and team attendance
 * heatmap/day-details/CSV export (reusing the attendance controller helpers).
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const Setting = require('../models/Setting');
const { LeaveRequest } = require('../models/Leave');
const { advanceApproval } = require('./leaveController');
const { startOfDayIST } = require('../utils/dateHelpers');
const { haversineMeters } = require('../utils/geo');
const { lateMinutes } = require('../utils/workday');
const {
  computeHeatmapWindow, computeDayDetails, runAttendanceExport,
  buildRestDayClaims, applyRestDayDecision,
} = require('./attendanceController');

// EmployeeProfile ids of the caller's direct reports (for team-scoped queries).
async function myReportIds(userId) {
  const rows = await EmployeeProfile.find({ reportingManager: userId }).select('_id').lean();
  return rows.map((p) => p._id);
}

// EmployeeProfile ids of the people who report directly to the current user.
async function myReportProfiles(userId) {
  return EmployeeProfile.find({ reportingManager: userId })
    .select('employeeCode designation department user workLocationRef')
    .populate('user', 'firstName lastName email photo')
    .populate('workLocationRef', 'name lat lng radiusM')
    .lean();
}

// The geofence a punch is measured against: the employee's assigned work
// location if set, else the global office. (Mirrors attendanceController.)
function resolveGeofence(profile, settings) {
  const wl = profile && profile.workLocationRef;
  if (wl && wl.lat != null && wl.lng != null) {
    return {
      center: { lat: wl.lat, lng: wl.lng },
      radiusM: wl.radiusM != null ? wl.radiusM : settings.geofenceThresholdM,
      label: wl.name || 'work location',
    };
  }
  return { center: settings.office, radiusM: settings.geofenceThresholdM, label: settings.office?.label || 'office' };
}

/**
 * List the caller's direct reports with each one's attendance snapshot for today.
 * @route GET /api/manager/team
 * @returns {{count: number, team: Object[]}} each with a `today` snapshot incl. geofence distances
 */
// GET /api/manager/team — my direct reports with today's attendance snapshot.
const listTeam = asyncHandler(async (req, res) => {
  const reports = await myReportProfiles(req.user._id);
  const ids = reports.map((p) => p._id);

  // Anchor the "today" window to the IST calendar day — punches store their date
  // at IST midnight, so a server-local (UTC) window would miss them.
  const today = startOfDayIST(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const [todays, settings] = await Promise.all([
    Attendance.find({ employee: { $in: ids }, date: { $gte: today, $lt: tomorrow } })
      .select('employee status checkIn checkOut hoursWorked checkInLocation checkOutLocation checkInWfh checkOutWfh')
      .lean(),
    Setting.getSettings(),
  ]);
  const byEmp = new Map(todays.map((a) => [String(a.employee), a]));

  const team = reports.map((p) => {
    const a = byEmp.get(String(p._id));
    let todayInfo = null;
    if (a) {
      const geo = resolveGeofence(p, settings);
      todayInfo = {
        status: a.status,
        checkIn: a.checkIn,
        checkOut: a.checkOut,
        hoursWorked: a.hoursWorked,
        checkInWfh: !!a.checkInWfh,
        checkOutWfh: !!a.checkOutWfh,
        // Distance of each punch from the employee's geofence centre (metres).
        checkInDistanceM: haversineMeters(geo.center, a.checkInLocation),
        checkOutDistanceM: haversineMeters(geo.center, a.checkOutLocation),
        geofenceRadiusM: geo.radiusM,
        locationName: geo.label,
      };
    }
    return {
      profileId: p._id,
      userId: p.user?._id,
      name: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim(),
      hasPhoto: Boolean(p.user?.photo),
      employeeCode: p.employeeCode,
      designation: p.designation || '',
      department: p.department || '',
      today: todayInfo,
    };
  });
  res.json({ count: team.length, team });
});

/**
 * Team presence board for today: who's present / on leave / absent among reports.
 * @route GET /api/manager/presence
 * @returns {{date, counts, present, onLeave, absent}}
 */
// GET /api/manager/presence — read-only "who's in / on leave / absent" today,
// scoped to the caller's direct reports. Same shape as the admin presence board
// so the UI is shared; the check-in selfie is surfaced the same way (identical
// whether the punch came from web or mobile).
const teamPresence = asyncHandler(async (req, res) => {
  const reports = await myReportProfiles(req.user._id);
  const byId = new Map(reports.map((p) => [String(p._id), p]));
  const ids = reports.map((p) => p._id);

  const today = startOfDayIST(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const [records, leaves] = await Promise.all([
    Attendance.find({ employee: { $in: ids }, date: { $gte: today, $lt: tomorrow }, checkIn: { $ne: null } })
      .select('employee checkIn checkOut checkInPhoto checkOutPhoto checkInWfh hoursWorked status')
      .lean(),
    LeaveRequest.find({ employee: { $in: ids }, status: 'Approved', startDate: { $lt: tomorrow }, endDate: { $gte: today } })
      .select('employee leaveType isHalfDay halfDaySession startDate endDate reason')
      .lean(),
  ]);

  const personCore = (p) => ({
    profileId: String(p._id),
    userId: p.user ? String(p.user._id) : null,
    name: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode,
    employeeCode: p.employeeCode,
    designation: p.designation || '',
    department: p.department || 'Unassigned',
    hasAvatar: Boolean(p.user?.photo),
  });

  const presentIds = new Set();
  const present = records
    .filter((r) => byId.has(String(r.employee)))
    .map((r) => {
      const p = byId.get(String(r.employee));
      presentIds.add(String(r.employee));
      return {
        ...personCore(p),
        recordId: String(r._id),
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut || null,
        hoursWorked: r.hoursWorked || 0,
        checkInWfh: !!r.checkInWfh,
        lateMinutes: lateMinutes(r),
        hasCheckInPhoto: !!r.checkInPhoto,
        hasCheckOutPhoto: !!r.checkOutPhoto,
      };
    })
    .sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));

  const leaveIds = new Set();
  const onLeave = leaves
    .filter((lv) => byId.has(String(lv.employee)) && !presentIds.has(String(lv.employee)))
    .map((lv) => {
      const p = byId.get(String(lv.employee));
      leaveIds.add(String(lv.employee));
      return {
        ...personCore(p),
        requestId: String(lv._id),
        leaveType: lv.leaveType,
        isHalfDay: !!lv.isHalfDay,
        halfDaySession: lv.halfDaySession || null,
        startDate: lv.startDate,
        endDate: lv.endDate,
        reason: lv.reason || '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const absent = reports
    .filter((p) => !presentIds.has(String(p._id)) && !leaveIds.has(String(p._id)))
    .map((p) => personCore(p))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    date: today,
    counts: { total: reports.length, present: present.length, onLeave: onLeave.length, absent: absent.length },
    present,
    onLeave,
    absent,
  });
});

/**
 * List leave requests from the caller's direct reports, optionally by status.
 * @route GET /api/manager/leave-requests?status=
 * @param {string} [req.query.status]
 * @returns {{count: number, requests: Object[]}} with populated employee/approver
 */
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

/**
 * Approve a report's leave request at this manager's chain step.
 * @route PATCH /api/manager/leave-requests/:id/approve
 * @param {string} req.params.id - leave request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}} (advances up the chain; final only at top rung)
 */
// PATCH /api/manager/leave-requests/:id/approve
// Delegates to the hierarchy-aware advanceApproval, which enforces that this
// manager is the CURRENT approver (their turn) before acting. Approving advances
// the request up the chain toward the CEO/MD; it is not a final decision unless
// this manager is the top rung. (Same logic as POST /api/approvals/leave.)
const approveTeamLeave = asyncHandler(async (req, res) => {
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
 * Reject a report's leave request at this manager's chain step.
 * @route PATCH /api/manager/leave-requests/:id/reject
 * @param {string} req.params.id - leave request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/manager/leave-requests/:id/reject
const rejectTeamLeave = asyncHandler(async (req, res) => {
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

/**
 * Team-scoped attendance heatmap over the last N days (delegates to attendanceController).
 * @route GET /api/manager/attendance/heatmap?days=
 * @param {number} [req.query.days] - capped at 400 (default 365)
 * @returns {Object} heatmap window scoped to the caller's reports
 */
// GET /api/manager/attendance/heatmap?days= — team-scoped attendance heatmap
// (same shape as the org heatmap, limited to the caller's direct reports).
const teamHeatmap = asyncHandler(async (req, res) => {
  const span = Math.min(Number(req.query.days) || 365, 400);
  const empIds = await myReportIds(req.user._id);
  res.json(await computeHeatmapWindow({ empIds, span }));
});

/**
 * Per-day attendance breakdown for the team (heatmap click-through).
 * @route GET /api/manager/attendance/day?date=YYYY-MM-DD
 * @param {string} req.query.date - YYYY-MM-DD (required)
 * @returns {Object} day details scoped to the caller's reports
 */
// GET /api/manager/attendance/day?date=YYYY-MM-DD — per-day breakdown with names
// for the heatmap click-through, limited to the caller's direct reports.
const teamDayDetails = asyncHandler(async (req, res) => {
  const dateStr = String(req.query.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    res.status(400);
    throw new Error('A valid date (YYYY-MM-DD) is required.');
  }
  const empIds = await myReportIds(req.user._id);
  res.json(await computeDayDetails({ empIds, dateStr }));
});

/**
 * Export team attendance as an .xlsx, scoped to the caller's direct reports.
 * @route GET /api/manager/attendance/export?year=&month=&day=&employee=&months=
 * @returns {application/vnd...spreadsheetml.sheet} attendance rows; an employee outside the team is rejected
 */
// GET /api/manager/attendance/export?year=&month=&day=&employee=&months=
// Attendance .xlsx scoped to the caller's direct reports (Sale
// Team included — anyone whose reportingManager is this user). Same shapes as
// the admin export: a single day, a whole month (all reports), or one report's
// month / trailing months. Passing an employee outside the team is rejected.
const exportTeamAttendance = asyncHandler(async (req, res) => {
  const scopeIds = await myReportIds(req.user._id);
  await runAttendanceExport(req, res, { scopeIds, bulkLabel: 'team' });
});

/**
 * Rest-day duty claims from the caller's direct reports — Sundays and org-wide
 * comp-off days they actually worked, which pay double once approved.
 * @route GET /api/manager/rest-day-work?year=&month=&state=
 * @returns {{year, month, counts, claims}} (empty for a non-manager)
 */
// GET /api/manager/rest-day-work
const listTeamRestDayWork = asyncHandler(async (req, res) => {
  const ids = await myReportIds(req.user._id);
  const now = new Date();
  if (!ids.length) {
    res.json({ year: now.getFullYear(), month: now.getMonth() + 1, counts: { pending: 0, approved: 0, rejected: 0 }, claims: [] });
    return;
  }
  res.json(await buildRestDayClaims({
    empIds: ids,
    year: Number(req.query.year) || now.getFullYear(),
    month: Number(req.query.month) || now.getMonth() + 1,
    state: req.query.state || 'all',
  }));
});

/**
 * Approve or reject one of the caller's reports' rest-day duty claims.
 * @route PATCH /api/manager/rest-day-work/:id
 * @param {'Approved'|'Rejected'} req.body.decision
 * @param {string} [req.body.note]
 * @returns {{record: Object}}; 403 when the record isn't a direct report's
 */
// PATCH /api/manager/rest-day-work/:id
const decideTeamRestDayWork = asyncHandler(async (req, res) => {
  const decision = req.body.decision;
  if (!['Approved', 'Rejected'].includes(decision)) {
    res.status(400);
    throw new Error('decision must be Approved or Rejected');
  }
  const record = await Attendance.findById(req.params.id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }
  const ids = await myReportIds(req.user._id);
  if (!ids.some((id) => String(id) === String(record.employee))) {
    res.status(403);
    throw new Error('That day belongs to someone who does not report to you');
  }
  try {
    await applyRestDayDecision(record, { decision, note: req.body.note, by: req.user });
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ record });
});

module.exports = {
  listTeam,
  teamPresence,
  listTeamLeave,
  approveTeamLeave,
  rejectTeamLeave,
  teamHeatmap,
  teamDayDetails,
  exportTeamAttendance,
  listTeamRestDayWork,
  decideTeamRestDayWork,
};
