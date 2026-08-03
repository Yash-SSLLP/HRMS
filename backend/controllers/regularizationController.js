/**
 * Regularization controller — attendance-correction requests. Employees raise
 * requests to fix a day's check-in/out; HR approve/reject, and an approval APPLIES
 * the corrected times straight onto the day's Attendance record (recording a
 * before/after snapshot). HR can also regularize any employee's day directly.
 */
const asyncHandler = require('express-async-handler');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { notify } = require('../services/notify');
const { startOfDayIST } = require('../utils/dateHelpers');
const { statusFromHours } = require('../utils/workday');

// `role` rides along so the review screen can tell an HR's own request apart
// from an ordinary employee's (see HR_REVIEW_ROLES below).
const EMPLOYEE_FIELDS = 'firstName lastName email role';

// HR review their own colleagues' attendance, so an HR's OWN regularization
// cannot be decided by HR — it goes up to an executive or a SuperAdmin. CEO/MD
// are read-only everywhere else; this route is a deliberate exception, the same
// shape as their existing role as reporting-chain leave approvers.
const HR_REVIEW_ROLES = ['SuperAdmin', 'CEO', 'MD'];
const HR_ROLE = 'HRManager';

// 'HH:mm' (or a full date string) + the request's day → a concrete Date on
// that IST day. Returns undefined when the value is empty/unparseable.
function timeOnDay(day, value) {
  if (!value) return undefined;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    return new Date(startOfDayIST(day).getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Apply an approved regularization to the employee's Attendance record for
// that day (creating the record if the day has none). Filling a check-out
// clears any "no punch-out" mark via the Attendance pre-save hook.
async function applyToAttendance(item, reviewer) {
  const profile = await EmployeeProfile.findOne({ user: item.employee });
  if (!profile) throw new Error('No employee profile linked to this user');

  const day = startOfDayIST(item.date);
  let record = await Attendance.findOne({ employee: profile._id, date: day });
  const isNew = !record;
  // Snapshot the BEFORE state so the audit view can show "from → to".
  const prevStatus = isNew ? 'No record' : record.status;
  const prevIn = isNew ? null : record.checkIn;
  const prevOut = isNew ? null : record.checkOut;
  if (!record) {
    record = new Attendance({ employee: profile._id, date: day, status: 'Present' });
  }
  const inAt = timeOnDay(item.date, item.requestedCheckIn);
  const outAt = timeOnDay(item.date, item.requestedCheckOut);
  if (inAt) record.checkIn = inAt;
  if (outAt) record.checkOut = outAt;
  if (record.checkIn && record.status === 'Absent') record.status = 'Present';
  // Re-derive the day from the corrected punches. This is what "half day until
  // regularization" means: a day auto-halved for short hours (or for a missing
  // punch-out counted to 7 PM) is restored to Present once the real times show
  // a full day — and stays a half day if they don't.
  record.status = statusFromHours(record) || record.status;
  const note = `Regularized (${item.type}) by ${reviewer?.fullName || 'HR'}: ${item.reason}`;
  record.remarks = record.remarks ? `${record.remarks} · ${note}` : note;
  await record.save();

  // Persist the before/after on the regularization for oversight (best-effort).
  item.previousStatus = prevStatus;
  item.previousCheckIn = prevIn || undefined;
  item.previousCheckOut = prevOut || undefined;
  item.appliedCheckIn = record.checkIn;
  item.appliedCheckOut = record.checkOut;
  try { await item.save(); } catch (err) { console.error('Regularization audit save failed:', err.message); }
  return record;
}

/**
 * List the caller's own regularization requests, newest first.
 * @route GET /api/regularizations/me
 * @returns {{count: number, items: Object[]}}
 */
// GET /api/regularizations/me  — the caller's own requests
const listMine = asyncHandler(async (req, res) => {
  const items = await Regularization.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

/**
 * Employee raises a regularization request (status Pending).
 * @route POST /api/regularizations
 * @param {string} req.body.date - required
 * @param {string} req.body.reason - required
 * @param {string} [req.body.type]
 * @param {string} [req.body.requestedCheckIn] - 'HH:mm' or date string
 * @param {string} [req.body.requestedCheckOut] - 'HH:mm' or date string
 * @returns {{item: Object}} (201)
 */
// POST /api/regularizations  { date, type, requestedCheckIn, requestedCheckOut, reason }
const createRequest = asyncHandler(async (req, res) => {
  const { date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;

  if (!date || !reason) {
    res.status(400);
    throw new Error('date and reason are required');
  }

  const item = await Regularization.create({
    employee: req.user._id,
    date,
    type,
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Pending',
  });

  res.status(201).json({ item });
});

/**
 * List all regularization requests, optionally filtered by status (admin).
 * @route GET /api/regularizations  (admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, items: Object[]}} with populated employee/reviewedBy
 */
// GET /api/regularizations  (admin) — optional ?status filter
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const items = await Regularization.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .populate('reviewedBy', 'firstName lastName role') // who did the regularization
    .sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

/**
 * Approve or reject a request; approval applies the fix to the Attendance record.
 * @route PATCH /api/regularizations/:id/status  (admin)
 * @param {string} req.params.id - request id
 * @param {string} req.body.status - 'Approved' or 'Rejected'
 * @param {string} [req.body.reviewNote]
 * @returns {{item: Object, applied: boolean}}
 * @sideeffect on approval writes to Attendance; notifies the employee either way
 */
// PATCH /api/regularizations/:id/status  (admin)  { status, reviewNote }
// Approving now also APPLIES the requested times to the day's Attendance
// record, so the fix is visible everywhere immediately.
const reviewRequest = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;

  if (!['Approved', 'Rejected'].includes(status)) {
    res.status(400);
    throw new Error('status must be Approved or Rejected');
  }

  const item = await Regularization.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Regularization request not found');
  }

  // Nobody signs off their own attendance correction, whatever their role.
  if (String(item.employee) === String(req.user._id)) {
    res.status(403);
    throw new Error('You cannot review your own regularization request.');
  }

  // An HR's own request needs an executive or a SuperAdmin — HR reviewing HR
  // (each other's, or their own via a colleague) would defeat the control.
  const requester = await User.findById(item.employee).select('role');
  if (requester?.role === HR_ROLE && !HR_REVIEW_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error('An HR regularization can only be approved by the CEO, MD or a Super Admin.');
  }
  // …and the exception goes no further: an exec's write access here covers HR
  // requests only. Everyone else's still belongs to HR, so CEO/MD stay
  // read-only on those, as on every other admin screen.
  if (['CEO', 'MD'].includes(req.user.role) && requester?.role !== HR_ROLE) {
    res.status(403);
    throw new Error('CEO/MD accounts review HR regularizations only; this one is for HR to decide.');
  }

  item.status = status;
  item.reviewNote = reviewNote;
  item.reviewedBy = req.user._id;
  item.reviewedAt = new Date();
  await item.save();

  let applied = null;
  if (status === 'Approved') {
    try {
      applied = await applyToAttendance(item, req.user);
    } catch (err) {
      // The decision stands even if applying fails (e.g. no profile) — HR can
      // still fix the record manually from the attendance views.
      console.error('Regularization apply failed:', err.message);
    }
  }

  notify({
    recipient: item.employee,
    type: 'regularization',
    audience: 'employee',
    title: `Attendance regularization ${status.toLowerCase()}`,
    body: `Your request for ${new Date(item.date).toLocaleDateString('en-IN', { dateStyle: 'medium' })} was ${status.toLowerCase()}${reviewNote ? ` - ${reviewNote}` : ''}.`,
    link: 'regularizations',
  }).catch(() => {});

  res.json({ item, applied: !!applied });
});

/**
 * HR regularizes any employee's day directly (recorded pre-Approved and applied).
 * @route POST /api/regularizations/admin  (admin)
 * @param {string} req.body.employee - target user id (required)
 * @param {string} req.body.date - required
 * @param {string} req.body.reason - required
 * @param {string} [req.body.type='Other']
 * @param {string} [req.body.requestedCheckIn]
 * @param {string} [req.body.requestedCheckOut]
 * @returns {{item: Object, record: Object}} (201)
 * @sideeffect writes to the day's Attendance record; notifies the employee
 */
// POST /api/regularizations/admin  (admin)
// { employee (User id), date, type, requestedCheckIn, requestedCheckOut, reason }
// HR regularizes any employee's attendance directly: the request is recorded
// as already Approved (for the audit trail) and applied to the day's record.
const adminCreate = asyncHandler(async (req, res) => {
  const { employee, date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;
  if (!employee || !date || !reason) {
    res.status(400);
    throw new Error('employee, date and reason are required');
  }

  // A direct regularization is self-approved by definition, so HR must not be
  // able to aim it at an HR (themselves or a colleague) — that would walk
  // straight around the review rule in reviewRequest above. They raise a
  // request instead, and an executive or SuperAdmin decides it.
  const target = await User.findById(employee).select('role');
  if (target?.role === HR_ROLE && !HR_REVIEW_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error(
      String(employee) === String(req.user._id)
        ? 'You cannot regularize your own attendance. Raise a request for the CEO, MD or a Super Admin to approve.'
        : "An HR's attendance can only be regularized by the CEO, MD or a Super Admin.",
    );
  }

  const item = await Regularization.create({
    employee,
    date,
    type: type || 'Other',
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Approved',
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
    reviewNote: 'Regularized directly by HR',
  });

  const record = await applyToAttendance(item, req.user);

  notify({
    recipient: employee,
    type: 'regularization',
    audience: 'employee',
    title: 'Your attendance was regularized',
    body: `HR updated your attendance for ${new Date(date).toLocaleDateString('en-IN', { dateStyle: 'medium' })}: ${reason}`,
    link: 'attendance',
  }).catch(() => {});

  res.status(201).json({ item, record });
});

module.exports = { listMine, createRequest, listAll, reviewRequest, adminCreate };
