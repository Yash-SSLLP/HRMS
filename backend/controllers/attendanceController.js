const asyncHandler = require('express-async-handler');
const path = require('path');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const storage = require('../services/storage');

function isAdmin(user) {
  return user.role === 'SuperAdmin' || user.role === 'HRManager';
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function monthRange(year, month) {
  const start = new Date(Number(year), Number(month) - 1, 1, 0, 0, 0, 0);
  const end = new Date(Number(year), Number(month), 1, 0, 0, 0, 0);
  return { start, end };
}

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

// ===== Employee =====

// Persist the uploaded selfie and return its storage-relative path.
function savePunchPhoto(req, profileId) {
  if (!req.file) {
    const err = new Error('A photo is required to punch. Please allow the camera and capture your photo.');
    err.status = 400;
    throw err;
  }
  const { storagePath } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'attendance',
    ownerId: profileId,
    originalName: req.file.originalname || 'punch.jpg',
  });
  return storagePath;
}

// POST /api/attendance/me/checkin   (multipart: photo)
const checkIn = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const today = startOfDay(new Date());

  let record = await Attendance.findOne({ employee: profile._id, date: today });
  if (record && record.checkIn) {
    res.status(400);
    throw new Error('Already checked in today');
  }
  const photoPath = savePunchPhoto(req, profile._id);
  if (!record) {
    record = new Attendance({ employee: profile._id, date: today });
  }
  record.checkIn = new Date();
  record.checkInPhoto = photoPath;
  record.status = 'Present';
  await record.save();
  res.status(201).json({ record });
});

// POST /api/attendance/me/checkout   (multipart: photo)
const checkOut = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const today = startOfDay(new Date());

  const record = await Attendance.findOne({ employee: profile._id, date: today });
  if (!record || !record.checkIn) {
    res.status(400);
    throw new Error('No check-in found for today');
  }
  if (record.checkOut) {
    res.status(400);
    throw new Error('Already checked out today');
  }
  const photoPath = savePunchPhoto(req, profile._id);
  record.checkOut = new Date();
  record.checkOutPhoto = photoPath;
  // Allow the employee to (re)mark this day as a half day at punch-out.
  if (req.body.halfDay === 'true') record.status = 'HalfDay';
  else if (req.body.halfDay === 'false') record.status = 'Present';
  await record.save();
  res.json({ record });
});

// GET /api/attendance/:id/photo/:which   (which = checkin | checkout)
// Visible to HR/SuperAdmin or the owning employee. Streams the image inline.
const getAttendancePhoto = asyncHandler(async (req, res) => {
  const { id, which } = req.params;
  if (!['checkin', 'checkout'].includes(which)) {
    res.status(400);
    throw new Error("which must be 'checkin' or 'checkout'");
  }
  const record = await Attendance.findById(id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }

  let allowed = isAdmin(req.user);
  if (!allowed) {
    const profile = await EmployeeProfile.findOne({ user: req.user._id });
    if (profile && profile._id.equals(record.employee)) allowed = true;
  }
  if (!allowed) {
    res.status(403);
    throw new Error('Not authorized to view this photo');
  }

  const relPath = which === 'checkin' ? record.checkInPhoto : record.checkOutPhoto;
  if (!relPath) {
    res.status(404);
    throw new Error('No photo for this punch');
  }

  const ext = path.extname(relPath).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  storage.readStream(relPath).pipe(res);
});

// GET /api/attendance/me?year=&month=
const listMine = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const records = await Attendance.find({
    employee: profile._id,
    date: { $gte: start, $lt: end },
  }).sort({ date: 1 });

  const todayKey = startOfDay(new Date()).getTime();
  const today = records.find((r) => startOfDay(r.date).getTime() === todayKey) || null;

  res.json({ year, month, today, count: records.length, records });
});

// ===== HR/Admin =====

// GET /api/attendance?year=&month=&employee=
const listAll = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const filter = { date: { $gte: start, $lt: end } };
  if (req.query.employee) filter.employee = req.query.employee;

  const records = await Attendance.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ date: -1, createdAt: -1 });

  res.json({ year, month, count: records.length, records });
});

// GET /api/attendance/today-board?department=
// Compact "Clock-In/Out" board for the admin dashboard: everyone who has
// punched in today, split into on-time vs late, with their clock in/out and
// production hours. "Late" = checked in after the standard start time.
const WORKDAY_START_HOUR = 10; // 10:00 AM grace cut-off for lateness
const todayBoard = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const records = await Attendance.find({
    date: { $gte: today, $lt: tomorrow },
    checkIn: { $ne: null },
  })
    .populate({
      path: 'employee',
      select: 'employeeCode designation department user',
      populate: { path: 'user', select: 'firstName lastName' },
    })
    .lean();

  const startThreshold = new Date(today);
  startThreshold.setHours(WORKDAY_START_HOUR, 0, 0, 0);

  let rows = records
    .filter((r) => r.employee && r.employee.user)
    .map((r) => {
      const p = r.employee;
      const lateMs = new Date(r.checkIn) - startThreshold;
      return {
        id: String(p._id),
        recordId: String(r._id),
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.employeeCode,
        designation: p.designation || '',
        department: p.department || 'Unassigned',
        checkIn: r.checkIn,
        checkOut: r.checkOut || null,
        hoursWorked: r.hoursWorked || 0,
        lateMinutes: lateMs > 0 ? Math.round(lateMs / 60000) : 0,
      };
    });

  const dept = req.query.department;
  if (dept && dept !== 'all') rows = rows.filter((r) => r.department === dept);

  rows.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));

  const departments = (await EmployeeProfile.distinct('department')).filter(Boolean).sort();

  res.json({
    date: today,
    onTime: rows.filter((r) => r.lateMinutes === 0),
    late: rows.filter((r) => r.lateMinutes > 0),
    departments,
  });
});

// POST /api/attendance  (manual admin entry)
const createRecord = asyncHandler(async (req, res) => {
  const { employee, date, status, checkIn, checkOut, remarks } = req.body;
  if (!employee || !date) {
    res.status(400);
    throw new Error('employee and date are required');
  }
  const day = startOfDay(date);
  const existing = await Attendance.findOne({ employee, date: day });
  if (existing) {
    res.status(409);
    throw new Error('Attendance for this date already exists; edit it instead');
  }
  const record = await Attendance.create({
    employee,
    date: day,
    status: status || 'Present',
    checkIn: checkIn || undefined,
    checkOut: checkOut || undefined,
    remarks,
  });
  res.status(201).json({ record });
});

// PUT /api/attendance/:id
const updateRecord = asyncHandler(async (req, res) => {
  const record = await Attendance.findById(req.params.id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }
  // Don't allow changing employee or date here
  delete req.body.employee;
  delete req.body.date;
  Object.assign(record, req.body);
  await record.save();
  res.json({ record });
});

// DELETE /api/attendance/:id
const deleteRecord = asyncHandler(async (req, res) => {
  const record = await Attendance.findById(req.params.id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }
  await record.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  checkIn,
  checkOut,
  getAttendancePhoto,
  listMine,
  listAll,
  todayBoard,
  createRecord,
  updateRecord,
  deleteRecord,
};
