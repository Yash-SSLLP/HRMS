/**
 * Dashboard controller — builds the SmartHR-style admin overview: summary cards
 * (headcount, present/leave/absent today, pending leaves, open complaints,
 * incomplete documents), headcount-by-department, recent pending leave requests,
 * and upcoming holidays. Read-only aggregation across several models.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const { LeaveRequest } = require('../models/Leave');
const Document = require('../models/Document');
const { REQUIRED_DOCUMENT_CATEGORIES } = require('../models/Document');
const Complaint = require('../models/Complaint');
const Department = require('../models/Department');
const Holiday = require('../models/Holiday');
// Anchor "today" to the IST calendar day (server runs in UTC) so the
// "Present today" count matches the day attendance punches are filed under.
const { startOfDayIST, ymdIST } = require('../utils/dateHelpers');

function startOfToday() {
  return startOfDayIST();
}

/**
 * Return the admin dashboard summary for the whole organisation.
 * @route GET /api/dashboard/admin  (HR/SuperAdmin)
 * @returns {{scope, cards, headcountByDepartment, pendingLeaveRequests, nextHolidays}}
 */
// GET /api/dashboard/admin
// SmartHR-style overview. HRManagers see figures scoped to their assigned
// employees; SuperAdmin sees the whole organisation.
const adminSummary = asyncHandler(async (req, res) => {
  const isHR = req.user.role === 'HRManager';

  const empFilter = {};

  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const in30 = new Date(today);
  in30.setDate(today.getDate() + 30);

  // All HR/SuperAdmin see the whole organisation — no per-HR employee scoping.
  //
  // Everyone this dashboard counts is an ACTIVE, not-yet-exited employee, the
  // same rule the presence board uses for its headcount. Counting every profile
  // ever created made "Total employees" — and the attendance donut, whose slices
  // are derived from it — read higher than the real headcount.
  const allProfiles = await EmployeeProfile.find({})
    .select('_id department documentsVerified dateOfExit user')
    .populate('user', 'isActive')
    .lean();
  const profiles = allProfiles.filter(
    (p) => p.user && p.user.isActive !== false && (!p.dateOfExit || new Date(p.dateOfExit) > today)
  );

  const [
    todayRecords,
    todayLeaves,
    pendingLeaves,
    departmentsCount,
    docs,
    pendingLeaveRequests,
    nextHolidays,
  ] = await Promise.all([
    Attendance.find({ ...empFilter, date: today, checkIn: { $ne: null } })
      .select('employee workOnLeave').lean(),
    LeaveRequest.find({
      ...empFilter,
      status: 'Approved',
      startDate: { $lt: tomorrow },
      endDate: { $gte: today },
    }).select('employee workedDays').lean(),
    LeaveRequest.countDocuments({ ...empFilter, status: 'Pending' }),
    Department.countDocuments({}),
    Document.find({}).select('employee category').lean(),
    LeaveRequest.find({ ...empFilter, status: 'Pending' })
      .populate({ path: 'employee', select: 'employeeCode user', populate: { path: 'user', select: 'firstName lastName' } })
      .sort({ appliedAt: -1 })
      .limit(8)
      .lean(),
    Holiday.find({ date: { $gte: today, $lt: in30 } }).sort({ date: 1 }).limit(5).lean(),
  ]);

  // Present / on leave / absent are three buckets over the SAME headcount, so
  // they are resolved as disjoint sets of employees rather than three
  // independent counts. Counting them separately let one person land in two
  // buckets — someone on approved leave who punched in was counted as present
  // AND on leave, which understated "absent" by the same amount.
  const activeIds = new Set(profiles.map((p) => String(p._id)));
  const todayKey = ymdIST(today);

  // A punch makes you present — unless the day's own record says the day is
  // still leave, which is the case while a work-on-leave claim is undecided.
  const heldOnLeave = new Set(
    todayRecords
      .filter((r) => r.workOnLeave && r.workOnLeave.status === 'Pending')
      .map((r) => String(r.employee))
  );
  const presentIds = new Set(
    todayRecords
      .filter((r) => activeIds.has(String(r.employee)) && !heldOnLeave.has(String(r.employee)))
      .map((r) => String(r.employee))
  );
  // On leave: an approved leave that still claims today. A day the employee
  // worked and had approved back (workedDays) is no longer leave, and someone
  // already counted present is never counted again here.
  const onLeaveIds = new Set(
    todayLeaves
      .filter((l) => activeIds.has(String(l.employee))
        && !(l.workedDays || []).includes(todayKey)
        && !presentIds.has(String(l.employee)))
      .map((l) => String(l.employee))
  );
  const presentToday = presentIds.size;
  const onLeaveToday = onLeaveIds.size;

  // Open complaints assigned to this admin (SuperAdmin: all open).
  const complaintFilter = { status: { $in: ['open', 'under_review'] } };
  if (isHR) complaintFilter.assignedTo = req.user._id;
  const openComplaints = await Complaint.countDocuments(complaintFilter);

  // Document completeness across scoped employees.
  const haveByEmp = new Map();
  for (const d of docs) {
    const k = String(d.employee);
    if (!haveByEmp.has(k)) haveByEmp.set(k, new Set());
    haveByEmp.get(k).add(d.category);
  }
  let documentsIncomplete = 0;
  for (const p of profiles) {
    if (p.documentsVerified) continue;
    const have = haveByEmp.get(String(p._id)) || new Set();
    if (REQUIRED_DOCUMENT_CATEGORIES.some((c) => !have.has(c))) documentsIncomplete += 1;
  }

  // Headcount by department (within scope).
  const deptCounts = {};
  for (const p of profiles) {
    const key = p.department || 'Unassigned';
    deptCounts[key] = (deptCounts[key] || 0) + 1;
  }
  const headcountByDepartment = Object.entries(deptCounts)
    .map(([department, count]) => ({ department, count }))
    .sort((a, b) => b.count - a.count);

  const totalEmployees = profiles.length;

  res.json({
    scope: 'all',
    cards: {
      totalEmployees,
      presentToday,
      onLeaveToday,
      absentToday: Math.max(0, totalEmployees - presentToday - onLeaveToday),
      pendingLeaves,
      openComplaints,
      departments: departmentsCount,
      documentsIncomplete,
    },
    headcountByDepartment,
    pendingLeaveRequests: pendingLeaveRequests.map((r) => ({
      _id: r._id,
      name: `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim(),
      employeeCode: r.employee?.employeeCode,
      leaveType: r.leaveType,
      startDate: r.startDate,
      endDate: r.endDate,
      totalDays: r.totalDays,
    })),
    nextHolidays: nextHolidays.map((h) => ({ name: h.name, date: h.date, type: h.type })),
  });
});

module.exports = { adminSummary };
