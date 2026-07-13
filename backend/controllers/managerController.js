const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const Setting = require('../models/Setting');
const { LeaveRequest } = require('../models/Leave');
const { advanceApproval } = require('./leaveController');
const { startOfDayIST } = require('../utils/dateHelpers');
const { haversineMeters } = require('../utils/geo');
const { computeHeatmapWindow, computeDayDetails } = require('./attendanceController');

// EmployeeProfile ids of the caller's direct reports (for team-scoped queries).
async function myReportIds(userId) {
  const rows = await EmployeeProfile.find({ reportingManager: userId }).select('_id').lean();
  return rows.map((p) => p._id);
}

const WORKDAY_START_HOUR = 10; // 10:00 AM IST grace cut-off for lateness (matches attendance board)

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
  const startThreshold = new Date(today.getTime() + WORKDAY_START_HOUR * 60 * 60 * 1000);

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
      const lateMs = new Date(r.checkIn) - startThreshold;
      return {
        ...personCore(p),
        recordId: String(r._id),
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut || null,
        hoursWorked: r.hoursWorked || 0,
        checkInWfh: !!r.checkInWfh,
        lateMinutes: lateMs > 0 ? Math.round(lateMs / 60000) : 0,
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

// GET /api/manager/attendance/heatmap?days= — team-scoped attendance heatmap
// (same shape as the org heatmap, limited to the caller's direct reports).
const teamHeatmap = asyncHandler(async (req, res) => {
  const span = Math.min(Number(req.query.days) || 365, 400);
  const empIds = await myReportIds(req.user._id);
  res.json(await computeHeatmapWindow({ empIds, span }));
});

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

module.exports = {
  listTeam,
  teamPresence,
  listTeamLeave,
  approveTeamLeave,
  rejectTeamLeave,
  teamHeatmap,
  teamDayDetails,
};
