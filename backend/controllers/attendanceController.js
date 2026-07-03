const asyncHandler = require('express-async-handler');
const path = require('path');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const Setting = require('../models/Setting');
const storage = require('../services/storage');
const { haversineMeters } = require('../utils/geo');
// All attendance "day" logic is anchored to the IST calendar day so it is
// independent of the server's timezone (the deployed backend runs in UTC).
// This keeps a punch made from any client (mobile or web) on the same IST day
// the user sees, so it surfaces correctly on the website's attendance views.
const { startOfDayIST: startOfDay, monthRangeIST: monthRange, ymdIST: ymdLocal } = require('../utils/dateHelpers');

function isAdmin(user) {
  return user.role === 'SuperAdmin' || user.role === 'HRManager';
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

// Parse the GPS location sent with a punch, if present and valid.
function parsePunchLocation(body) {
  const lat = parseFloat(body.latitude);
  const lng = parseFloat(body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  const accuracy = parseFloat(body.accuracy);
  return { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : undefined };
}

// Apply the Office & Geofence rule to a punch. A punch made beyond the
// configured radius from the office (and not marked WFH) is captured as an
// out-of-office punch — the punch is never blocked. WFH punches are exempt,
// as they are expected to be away from the office. Returns the distance in
// metres (or null when no location was captured) so callers can note it.
function evaluateGeofence(loc, wfh, settings) {
  const threshold = settings.geofenceThresholdM;
  const distanceM = loc ? haversineMeters(settings.office, loc) : null;
  const outside = Boolean(
    !wfh && threshold && distanceM != null && distanceM > threshold
  );
  return { distanceM, outside };
}

// Append a note to a record's remarks without dropping any existing text, and
// without duplicating the same note if the punch is retried/edited.
function appendRemark(existing, note) {
  const base = (existing || '').trim();
  if (!base) return note;
  if (base.includes(note)) return base;
  return `${base} ${note}`;
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
  const loc = parsePunchLocation(req.body);
  if (loc) record.checkInLocation = loc;
  record.checkInWfh = req.body.wfh === 'true';
  // Office & Geofence rule: capture (but never block) an out-of-office punch.
  const settings = await Setting.getSettings();
  const { distanceM, outside } = evaluateGeofence(loc, record.checkInWfh, settings);
  record.checkInOutsideGeofence = outside;
  if (outside) {
    record.remarks = appendRemark(record.remarks, `Check-in outside office (${distanceM} m).`);
  }
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
  const loc = parsePunchLocation(req.body);
  if (loc) record.checkOutLocation = loc;
  record.checkOutWfh = req.body.wfh === 'true';
  // Office & Geofence rule: capture (but never block) an out-of-office punch.
  const settings = await Setting.getSettings();
  const { distanceM, outside } = evaluateGeofence(loc, record.checkOutWfh, settings);
  record.checkOutOutsideGeofence = outside;
  if (outside) {
    record.remarks = appendRemark(record.remarks, `Check-out outside office (${distanceM} m).`);
  }
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
  if (!storage.streamTo(relPath, res)) return res.status(404).json({ message: 'File not found' });
});

// GET /api/attendance/me/heatmap?days=365
// Returns the caller's day-by-day attendance classification over the trailing
// window for a GitHub-style heatmap. Each day is one of:
//   full | half | leave | compoff | absent   (days with no record are omitted).
// Combines attendance records, approved leave ranges and availed comp-offs.
// No employee profile (e.g. SuperAdmin) → empty list.
const myHeatmap = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id });
  if (!profile) return res.json({ days: [] });

  const span = Math.min(Number(req.query.days) || 365, 400);
  const end = startOfDay(new Date());
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - (span - 1));

  const { LeaveRequest } = require('../models/Leave');
  const CompOff = require('../models/CompOff');

  const [records, leaves, comps] = await Promise.all([
    Attendance.find({ employee: profile._id, date: { $gte: start, $lte: end } })
      .select('date status').lean(),
    LeaveRequest.find({ employee: profile._id, status: 'Approved', startDate: { $lte: end }, endDate: { $gte: start } })
      .select('startDate endDate isHalfDay').lean(),
    CompOff.find({ employee: req.user._id, status: 'Availed', availedOn: { $gte: start, $lte: end } })
      .select('availedOn').lean(),
  ]);

  const att = {};
  for (const r of records) att[ymdLocal(r.date)] = r.status;

  const compoffSet = new Set(comps.filter((c) => c.availedOn).map((c) => ymdLocal(c.availedOn)));

  const leaveSet = new Set();
  for (const lv of leaves) {
    const d = startOfDay(new Date(lv.startDate));
    const last = startOfDay(new Date(lv.endDate));
    while (d <= last) {
      if (d >= start && d <= end) leaveSet.add(ymdLocal(d));
      d.setDate(d.getDate() + 1);
    }
  }

  // Classify each day in the window (worked days take priority over leave/absent).
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const key = ymdLocal(cur);
    const status = att[key];
    let category = null;
    if (status === 'Present') category = 'full';
    else if (status === 'HalfDay') category = 'half';
    else if (compoffSet.has(key)) category = 'compoff';
    else if (leaveSet.has(key) || status === 'OnLeave') category = 'leave';
    else if (status === 'Absent') category = 'absent';
    if (category) days.push({ date: key, category });
    cur.setDate(cur.getDate() + 1);
  }

  res.json({ from: ymdLocal(start), to: ymdLocal(end), days });
});

// GET /api/attendance/org/heatmap?days=365  (HR/Admin)
// Org-wide daily attendance counts for a heatmap: per day, how many employees
// were full-day / half-day / on leave / comp-off / absent. Intensity = number
// present (full + half). One category per employee per day, same precedence as
// the personal heatmap: worked > comp-off > leave > absent.
const orgHeatmap = asyncHandler(async (req, res) => {
  const span = Math.min(Number(req.query.days) || 365, 400);
  const end = startOfDay(new Date());
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - (span - 1));

  const { LeaveRequest } = require('../models/Leave');
  const CompOff = require('../models/CompOff');

  const [profiles, records, leaves, comps] = await Promise.all([
    EmployeeProfile.find({}).select('_id user').lean(),
    Attendance.find({ date: { $gte: start, $lte: end } }).select('employee date status').lean(),
    LeaveRequest.find({ status: 'Approved', startDate: { $lte: end }, endDate: { $gte: start } })
      .select('employee startDate endDate').lean(),
    CompOff.find({ status: 'Availed', availedOn: { $gte: start, $lte: end } })
      .select('employee availedOn').lean(),
  ]);

  const totalEmployees = profiles.length;
  // CompOff.employee is a User id; map it to the EmployeeProfile id used elsewhere.
  const userToEmp = {};
  for (const p of profiles) userToEmp[String(p.user)] = String(p._id);

  // One category per (employee, day).
  const cls = new Map(); // `${empId}|${ymd}` -> category

  for (const r of records) {
    const key = `${String(r.employee)}|${ymdLocal(r.date)}`;
    if (r.status === 'Present') cls.set(key, 'full');
    else if (r.status === 'HalfDay') cls.set(key, 'half');
    else if (r.status === 'OnLeave') cls.set(key, 'leave');
    else if (r.status === 'Absent') cls.set(key, 'absent');
  }

  // Approved leave ranges fill in days that are empty or only marked absent.
  for (const lv of leaves) {
    const emp = String(lv.employee);
    const d = startOfDay(new Date(lv.startDate));
    const last = startOfDay(new Date(lv.endDate));
    while (d <= last) {
      if (d >= start && d <= end) {
        const key = `${emp}|${ymdLocal(d)}`;
        const cur = cls.get(key);
        if (!cur || cur === 'absent') cls.set(key, 'leave');
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Availed comp-off beats everything except an actual worked day.
  for (const c of comps) {
    if (!c.availedOn) continue;
    const emp = userToEmp[String(c.employee)];
    if (!emp) continue;
    const key = `${emp}|${ymdLocal(c.availedOn)}`;
    const cur = cls.get(key);
    if (cur !== 'full' && cur !== 'half') cls.set(key, 'compoff');
  }

  const byDay = {};
  for (const [key, cat] of cls) {
    const ymd = key.split('|')[1];
    const b = byDay[ymd] || (byDay[ymd] = { date: ymd, full: 0, half: 0, leave: 0, compoff: 0, absent: 0 });
    b[cat] += 1;
  }

  let maxPresent = 0;
  const days = Object.values(byDay).map((b) => {
    const present = b.full + b.half;
    if (present > maxPresent) maxPresent = present;
    return { ...b, present };
  });

  res.json({ from: ymdLocal(start), to: ymdLocal(end), totalEmployees, maxPresent, days });
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

  // Attach each punch's distance from the configured office, for HR review.
  const settings = await Setting.getSettings();
  const office = settings.office;
  const out = records.map((r) => {
    const o = r.toJSON();
    o.checkInDistanceM = haversineMeters(office, o.checkInLocation);
    o.checkOutDistanceM = haversineMeters(office, o.checkOutLocation);
    return o;
  });

  res.json({
    year,
    month,
    count: out.length,
    records: out,
    settings: { office, geofenceThresholdM: settings.geofenceThresholdM },
  });
});

// GET /api/attendance/month-summary?employee=&year=&month=
// One employee's whole month for HR/admin review: every day's punches with
// late / distance / no-punch-out flags, plus the roll-up counts shown in the
// summary bar (working days, on-time, late, leave …).
const monthSummary = asyncHandler(async (req, res) => {
  if (!req.query.employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const [profile, records, settings, holidays] = await Promise.all([
    EmployeeProfile.findById(req.query.employee)
      .select('employeeCode designation department user')
      .populate('user', 'firstName lastName email'),
    Attendance.find({ employee: req.query.employee, date: { $gte: start, $lt: end } }).sort({ date: -1 }),
    Setting.getSettings(),
    require('../models/Holiday').find({ date: { $gte: start, $lt: end } }).select('date name').catch(() => []),
  ]);
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }

  const office = settings.office;
  const threshold = settings.geofenceThresholdM;
  const todayStart = startOfDay(new Date());
  const holidayKeys = new Set((holidays || []).map((h) => ymdLocal(h.date)));

  const days = records.map((r) => {
    const o = r.toJSON();
    // Late = checked in after the standard start (r.date is IST midnight).
    const lateCutoff = new Date(new Date(r.date).getTime() + WORKDAY_START_HOUR * 60 * 60 * 1000);
    const lateMs = r.checkIn ? new Date(r.checkIn) - lateCutoff : 0;
    o.lateMinutes = lateMs > 0 ? Math.round(lateMs / 60000) : 0;
    o.checkInDistanceM = haversineMeters(office, o.checkInLocation);
    o.checkOutDistanceM = haversineMeters(office, o.checkOutLocation);
    o.distantPunch = Boolean(
      threshold &&
      ((o.checkInDistanceM != null && o.checkInDistanceM > threshold && !o.checkInWfh) ||
        (o.checkOutDistanceM != null && o.checkOutDistanceM > threshold && !o.checkOutWfh))
    );
    // Show "no punch-out" as soon as the day is over, even before the nightly
    // worker stamps it.
    o.noPunchOut = o.noPunchOut || Boolean(r.checkIn && !r.checkOut && startOfDay(r.date) < todayStart);
    return o;
  });

  // Working days this month = calendar days minus Sundays minus listed holidays.
  const daysInMonth = Math.round((end - start) / 86400000);
  let workingDays = 0;
  for (let i = 0; i < daysInMonth; i += 1) {
    const d = new Date(start.getTime() + i * 86400000 + 12 * 3600000); // midday, DST-safe
    const key = ymdLocal(d);
    const istDow = new Date(d.getTime()).getUTCDay(); // d is IST-anchored midday
    if (istDow !== 0 && !holidayKeys.has(key)) workingDays += 1;
  }

  const present = days.filter((d) => ['Present', 'HalfDay'].includes(d.status) && d.checkIn);
  const summary = {
    workingDays,
    presentDays: present.length,
    onTime: present.filter((d) => d.lateMinutes === 0).length,
    late: present.filter((d) => d.lateMinutes > 0).length,
    leave: days.filter((d) => d.status === 'OnLeave').length,
    halfDay: days.filter((d) => d.status === 'HalfDay').length,
    absent: days.filter((d) => d.status === 'Absent').length,
    holiday: days.filter((d) => ['Holiday', 'WeeklyOff'].includes(d.status)).length,
    noPunchOut: days.filter((d) => d.noPunchOut).length,
    distantPunches: days.filter((d) => d.distantPunch).length,
    totalHours: +days.reduce((a, d) => a + (d.hoursWorked || 0), 0).toFixed(1),
  };

  res.json({
    year,
    month,
    employee: profile,
    summary,
    records: days,
    settings: { office, geofenceThresholdM: threshold },
  });
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

  // `today` is IST midnight; add the grace hours to get 10:00 AM IST exactly,
  // independent of the server's timezone.
  const startThreshold = new Date(today.getTime() + WORKDAY_START_HOUR * 60 * 60 * 1000);

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

// GET /api/attendance/settings  (HR/Admin)
// Returns the office location + geofence threshold used for punch distances.
const getSettings = asyncHandler(async (req, res) => {
  const s = await Setting.getSettings();
  res.json({ office: s.office, geofenceThresholdM: s.geofenceThresholdM });
});

// PUT /api/attendance/settings  (HR/Admin)
// Update the office coordinates/label and/or the geofence threshold (metres).
const updateSettings = asyncHandler(async (req, res) => {
  const s = await Setting.getSettings();
  const { lat, lng, label } = req.body.office || {};
  if (lat != null && Number.isFinite(Number(lat))) s.office.lat = Number(lat);
  if (lng != null && Number.isFinite(Number(lng))) s.office.lng = Number(lng);
  if (typeof label === 'string' && label.trim()) s.office.label = label.trim();
  if (req.body.geofenceThresholdM != null && Number.isFinite(Number(req.body.geofenceThresholdM))) {
    s.geofenceThresholdM = Math.max(0, Number(req.body.geofenceThresholdM));
  }
  await s.save();
  res.json({ office: s.office, geofenceThresholdM: s.geofenceThresholdM });
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
  myHeatmap,
  orgHeatmap,
  listMine,
  listAll,
  monthSummary,
  todayBoard,
  createRecord,
  updateRecord,
  deleteRecord,
  getSettings,
  updateSettings,
};
