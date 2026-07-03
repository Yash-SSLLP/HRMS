const asyncHandler = require('express-async-handler');
const Course = require('../models/Course');
const { Enrollment } = require('../models/Course');
const { parseDriveFileId, streamDriveFile } = require('../utils/drive');
const { notify, notifyMany } = require('../services/notify');
const User = require('../models/User');

// Roles allowed to manage courses / assign / approve. Add 'LDManager' here once
// that role exists — this is the single place that gates course administration.
const COURSE_ADMIN_ROLES = ['SuperAdmin', 'HRManager'];
const isCourseAdmin = (user) => user && COURSE_ADMIN_ROLES.includes(user.role);

// Add `daysToDue` / `overdue` to an enrollment-ish object for the client.
function withDueMeta(obj) {
  if (!obj.dueDate) return { ...obj, daysToDue: null, overdue: false };
  const ms = new Date(obj.dueDate).getTime() - Date.now();
  const daysToDue = Math.ceil(ms / 86400000);
  const overdue = ms < 0 && obj.status !== 'Completed';
  return { ...obj, daysToDue, overdue };
}

// Recompute an enrollment's overall progress + lifecycle status from its
// per-module completion, and persist. Progress is the share of modules completed.
function recomputeProgress(enrollment, course) {
  const total = course.modules.length;
  const completed = (enrollment.moduleProgress || []).filter((m) => m.completed).length;
  const progress = total === 0 ? 100 : Math.round((completed / total) * 100);
  enrollment.progress = progress;
  if (progress >= 100) {
    enrollment.status = 'Completed';
    enrollment.completedAt = enrollment.completedAt || new Date();
  } else if (progress > 0) {
    enrollment.status = 'InProgress';
    enrollment.completedAt = undefined;
  } else {
    enrollment.status = 'Enrolled';
    enrollment.completedAt = undefined;
  }
}

// Normalize an incoming module list: coerce type, parse the Drive id from the
// link, and reject a video module whose link has no resolvable file id.
function normalizeModules(modules) {
  if (!Array.isArray(modules)) return [];
  return modules.map((m, i) => {
    const type = m.type === 'text' ? 'text' : 'video';
    const out = { title: (m.title || '').trim(), type, content: m.content || '', durationSec: Number(m.durationSec) || 0 };
    if (m._id) out._id = m._id; // keep stable ids on edit
    if (type === 'video') {
      const link = (m.driveUrl || m.url || '').trim();
      const fileId = parseDriveFileId(link);
      if (!fileId) {
        const err = new Error(`Module ${i + 1} ("${out.title || 'Untitled'}"): enter a valid Google Drive video link.`);
        err.status = 400;
        throw err;
      }
      out.driveUrl = link;
      out.driveFileId = fileId;
    }
    if (!out.title) {
      const err = new Error(`Module ${i + 1}: title is required.`);
      err.status = 400;
      throw err;
    }
    return out;
  });
}

// ===== Shared / Employee =====

// GET /api/courses  — active courses for everyone, with caller's enrollment if any
const listCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find({ active: true }).sort({ createdAt: -1 }).lean();
  const enrollments = await Enrollment.find({ employee: req.user._id }).lean();
  const byCourse = {};
  enrollments.forEach((e) => { byCourse[String(e.course)] = e; });

  const withEnrollment = courses.map((c) => {
    const e = byCourse[String(c._id)];
    return {
      ...c,
      moduleCount: (c.modules || []).length,
      videoCount: (c.modules || []).filter((m) => m.type !== 'text').length,
      // Don't leak Drive links/file ids in the catalog listing.
      modules: undefined,
      enrollment: e
        ? withDueMeta({ status: e.status, approvalStatus: e.approvalStatus, progress: e.progress, dueDate: e.dueDate, source: e.source })
        : null,
    };
  });
  res.json({ count: withEnrollment.length, courses: withEnrollment });
});

// Strip a course's Drive links so employees only ever reach the video through
// the authenticated in-portal stream endpoint, never the raw Drive URL.
function safeCourse(course) {
  if (!course) return course;
  const modules = (course.modules || []).map((m) => ({
    _id: m._id,
    title: m.title,
    type: m.type,
    content: m.content,
    durationSec: m.durationSec,
  }));
  return { ...course, modules };
}

// GET /api/courses/me — all enrollments for caller, populated with course
const myLearning = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ employee: req.user._id })
    .populate('course')
    .sort({ createdAt: -1 })
    .lean();
  const out = enrollments.map((e) => withDueMeta({ ...e, course: safeCourse(e.course) }));
  res.json({ count: out.length, enrollments: out });
});

// POST /api/courses/:id/enroll — employee self-enroll (needs approval)
const enroll = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course || !course.active) {
    res.status(404);
    throw new Error('Course not found');
  }
  const existing = await Enrollment.findOne({ course: course._id, employee: req.user._id });
  if (existing) {
    return res.status(200).json({ enrollment: existing });
  }
  const enrollment = await Enrollment.create({
    course: course._id,
    employee: req.user._id,
    source: 'Self',
    approvalStatus: 'Pending',
  });

  // Tell course admins there's a request to approve.
  const admins = await User.find({ role: { $in: COURSE_ADMIN_ROLES }, isActive: true }).select('_id').lean();
  notifyMany(admins.map((a) => a._id), {
    type: 'course',
    title: 'Course enrollment request',
    body: `${req.user.fullName || 'An employee'} requested to enroll in "${course.title}".`,
    link: '/admin/courses',
  }).catch(() => {});

  res.status(201).json({ enrollment });
});

// GET /api/courses/:id/modules/:mid/video — proxy-stream the module's Drive video
const streamModuleVideo = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const module = course.modules.id(req.params.mid);
  if (!module || module.type !== 'video' || !module.driveFileId) {
    res.status(404);
    throw new Error('Video not found');
  }

  // Access: a course admin (preview) or an employee with an Approved enrollment.
  let allowed = isCourseAdmin(req.user);
  if (!allowed) {
    const enr = await Enrollment.findOne({ course: course._id, employee: req.user._id }).select('approvalStatus').lean();
    allowed = enr && enr.approvalStatus === 'Approved';
  }
  if (!allowed) {
    res.status(403);
    throw new Error('You must be enrolled and approved to watch this video.');
  }

  await streamDriveFile(module.driveFileId, req, res);
});

// Load the caller's Approved enrollment for a course, or fail with a clear error.
async function getApprovedEnrollment(courseId, userId, res) {
  const enrollment = await Enrollment.findOne({ course: courseId, employee: userId });
  if (!enrollment) {
    res.status(404);
    throw new Error('Enrollment not found');
  }
  if (enrollment.approvalStatus !== 'Approved') {
    res.status(403);
    throw new Error('Your enrollment is not approved yet.');
  }
  return enrollment;
}

// PATCH /api/courses/:id/modules/:mid/progress  { watchedSec, durationSec }
const updateModuleProgress = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const module = course.modules.id(req.params.mid);
  if (!module) {
    res.status(404);
    throw new Error('Module not found');
  }
  const enrollment = await getApprovedEnrollment(course._id, req.user._id, res);

  const watchedSec = Math.max(0, Number(req.body.watchedSec) || 0);
  const durationSec = Math.max(0, Number(req.body.durationSec) || 0);

  let mp = enrollment.moduleProgress.find((m) => String(m.module) === String(module._id));
  if (!mp) {
    mp = { module: module._id, watchedSec: 0, durationSec: 0, completed: false };
    enrollment.moduleProgress.push(mp);
    mp = enrollment.moduleProgress[enrollment.moduleProgress.length - 1];
  }
  // Watched time only ever increases; keep the best duration we've seen.
  mp.watchedSec = Math.max(mp.watchedSec || 0, watchedSec);
  if (durationSec > 0) mp.durationSec = durationSec;
  // Complete once ~95% of a known-length video has actually been watched.
  if (!mp.completed && mp.durationSec > 0 && mp.watchedSec >= 0.95 * mp.durationSec) {
    mp.completed = true;
    mp.completedAt = new Date();
  }

  recomputeProgress(enrollment, course);
  await enrollment.save();
  res.json({ enrollment: withDueMeta(enrollment.toObject()) });
});

// POST /api/courses/:id/modules/:mid/complete — mark a TEXT module read
const completeTextModule = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const module = course.modules.id(req.params.mid);
  if (!module || module.type !== 'text') {
    res.status(400);
    throw new Error('Not a text module');
  }
  const enrollment = await getApprovedEnrollment(course._id, req.user._id, res);

  const done = req.body.completed !== false; // default true
  let mp = enrollment.moduleProgress.find((m) => String(m.module) === String(module._id));
  if (!mp) {
    enrollment.moduleProgress.push({ module: module._id, completed: done, completedAt: done ? new Date() : undefined });
  } else {
    mp.completed = done;
    mp.completedAt = done ? new Date() : undefined;
  }
  recomputeProgress(enrollment, course);
  await enrollment.save();
  res.json({ enrollment: withDueMeta(enrollment.toObject()) });
});

// ===== Admin =====

// GET /api/courses/admin/all — all courses incl inactive, with enrollment counts
const listAdmin = asyncHandler(async (req, res) => {
  const courses = await Course.find().sort({ createdAt: -1 }).lean();
  const withCounts = await Promise.all(
    courses.map(async (c) => {
      const [enrollments] = await Promise.all([
        Enrollment.find({ course: c._id }).select('status approvalStatus dueDate').lean(),
      ]);
      const approved = enrollments.filter((e) => e.approvalStatus === 'Approved');
      const overdue = approved.filter(
        (e) => e.dueDate && e.status !== 'Completed' && new Date(e.dueDate).getTime() < Date.now()
      ).length;
      return {
        ...c,
        moduleCount: (c.modules || []).length,
        videoCount: (c.modules || []).filter((m) => m.type !== 'text').length,
        enrollmentCount: approved.length,
        completedCount: approved.filter((e) => e.status === 'Completed').length,
        pendingCount: enrollments.filter((e) => e.approvalStatus === 'Pending').length,
        overdueCount: overdue,
      };
    })
  );
  res.json({ count: withCounts.length, courses: withCounts });
});

// POST /api/courses
const createCourse = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const modules = normalizeModules(req.body.modules);
  const course = await Course.create({
    title: req.body.title,
    description: req.body.description,
    category: req.body.category,
    durationHours: Number(req.body.durationHours) || 0,
    deadlineDays: Number(req.body.deadlineDays) || 0,
    active: req.body.active !== false,
    modules,
    createdBy: req.user._id,
  });
  res.status(201).json({ course });
});

// PUT /api/courses/:id
const updateCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const fields = ['title', 'description', 'category'];
  fields.forEach((f) => { if (req.body[f] !== undefined) course[f] = req.body[f]; });
  if (req.body.durationHours !== undefined) course.durationHours = Number(req.body.durationHours) || 0;
  if (req.body.deadlineDays !== undefined) course.deadlineDays = Number(req.body.deadlineDays) || 0;
  if (req.body.active !== undefined) course.active = !!req.body.active;
  if (req.body.modules !== undefined) course.modules = normalizeModules(req.body.modules);
  await course.save();
  res.json({ course });
});

// DELETE /api/courses/:id — also remove enrollments
const deleteCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  await Enrollment.deleteMany({ course: course._id });
  await course.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// Compute a due date from an explicit value or the course's deadlineDays.
function computeDueDate(course, explicit) {
  if (explicit) return new Date(explicit);
  if (course.deadlineDays > 0) return new Date(Date.now() + course.deadlineDays * 86400000);
  return undefined;
}

// POST /api/courses/:id/assign  { employeeIds: [userId], dueDate? }
const assignCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const employeeIds = [...new Set((req.body.employeeIds || []).map(String))].filter(Boolean);
  if (!employeeIds.length) {
    res.status(400);
    throw new Error('Select at least one employee to assign.');
  }
  const dueDate = computeDueDate(course, req.body.dueDate);

  const results = [];
  for (const employee of employeeIds) {
    let enr = await Enrollment.findOne({ course: course._id, employee });
    if (!enr) enr = new Enrollment({ course: course._id, employee });
    enr.source = 'Assigned';
    enr.approvalStatus = 'Approved';
    enr.assignedBy = req.user._id;
    if (dueDate) enr.dueDate = dueDate;
    await enr.save();
    results.push(enr._id);
  }

  notifyMany(employeeIds, {
    type: 'course',
    title: 'New course assigned',
    body: `You've been assigned "${course.title}"${dueDate ? ` — due ${dueDate.toLocaleDateString('en-IN')}` : ''}.`,
    link: '/learning',
  }).catch(() => {});

  res.status(201).json({ assigned: results.length });
});

// GET /api/courses/enrollments/pending — self-enroll requests awaiting approval
const listPending = asyncHandler(async (req, res) => {
  const pending = await Enrollment.find({ approvalStatus: 'Pending' })
    .populate('course', 'title category')
    .populate('employee', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ count: pending.length, enrollments: pending });
});

// GET /api/courses/:id/enrollments — roster for one course
const courseRoster = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ course: req.params.id })
    .populate('employee', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ count: enrollments.length, enrollments: enrollments.map(withDueMeta) });
});

// PATCH /api/courses/enrollments/:eid/approve  { dueDate? }
const approveEnrollment = asyncHandler(async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.eid).populate('course', 'title deadlineDays');
  if (!enrollment) {
    res.status(404);
    throw new Error('Enrollment not found');
  }
  enrollment.approvalStatus = 'Approved';
  enrollment.assignedBy = req.user._id;
  const dueDate = computeDueDate(enrollment.course, req.body.dueDate);
  if (dueDate) enrollment.dueDate = dueDate;
  await enrollment.save();

  notify({
    recipient: enrollment.employee,
    type: 'course',
    title: 'Enrollment approved',
    body: `Your enrollment in "${enrollment.course.title}" was approved.`,
    link: '/learning',
  }).catch(() => {});

  res.json({ enrollment });
});

// PATCH /api/courses/enrollments/:eid/reject
const rejectEnrollment = asyncHandler(async (req, res) => {
  const enrollment = await Enrollment.findById(req.params.eid).populate('course', 'title');
  if (!enrollment) {
    res.status(404);
    throw new Error('Enrollment not found');
  }
  enrollment.approvalStatus = 'Rejected';
  await enrollment.save();

  notify({
    recipient: enrollment.employee,
    type: 'course',
    title: 'Enrollment declined',
    body: `Your request to enroll in "${enrollment.course.title}" was declined.`,
    link: '/learning',
  }).catch(() => {});

  res.json({ enrollment });
});

module.exports = {
  listCourses,
  myLearning,
  enroll,
  streamModuleVideo,
  updateModuleProgress,
  completeTextModule,
  listAdmin,
  createCourse,
  updateCourse,
  deleteCourse,
  assignCourse,
  listPending,
  courseRoster,
  approveEnrollment,
  rejectEnrollment,
};
