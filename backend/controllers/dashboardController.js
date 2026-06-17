const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const { LeaveRequest } = require('../models/Leave');
const Document = require('../models/Document');
const { REQUIRED_DOCUMENT_CATEGORIES } = require('../models/Document');
const Complaint = require('../models/Complaint');
const Department = require('../models/Department');
const Holiday = require('../models/Holiday');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/dashboard/admin
// SmartHR-style overview. HRManagers see figures scoped to their assigned
// employees; SuperAdmin sees the whole organisation.
const adminSummary = asyncHandler(async (req, res) => {
  const isHR = req.user.role === 'HRManager';

  // Resolve the set of employee profiles in scope.
  const profileFilter = isHR ? { hrPartner: req.user._id } : {};
  const profiles = await EmployeeProfile.find(profileFilter)
    .select('_id department documentsVerified')
    .lean();
  const ids = profiles.map((p) => p._id);
  const empFilter = isHR ? { employee: { $in: ids } } : {};

  const today = startOfToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const in30 = new Date(today);
  in30.setDate(today.getDate() + 30);

  const [
    presentToday,
    onLeaveToday,
    pendingLeaves,
    departmentsCount,
    docs,
    pendingLeaveRequests,
    nextHolidays,
  ] = await Promise.all([
    Attendance.countDocuments({ ...empFilter, date: today, checkIn: { $ne: null } }),
    LeaveRequest.countDocuments({
      ...empFilter,
      status: 'Approved',
      startDate: { $lte: tomorrow },
      endDate: { $gte: today },
    }),
    LeaveRequest.countDocuments({ ...empFilter, status: 'Pending' }),
    Department.countDocuments({}),
    Document.find(isHR ? { employee: { $in: ids } } : {}).select('employee category').lean(),
    LeaveRequest.find({ ...empFilter, status: 'Pending' })
      .populate({ path: 'employee', select: 'employeeCode user', populate: { path: 'user', select: 'firstName lastName' } })
      .sort({ appliedAt: -1 })
      .limit(8)
      .lean(),
    Holiday.find({ date: { $gte: today, $lt: in30 } }).sort({ date: 1 }).limit(5).lean(),
  ]);

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
    scope: isHR ? 'mine' : 'all',
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
