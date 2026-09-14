/**
 * Course/LMS controller — internal courses with video (Cloudinary signed upload +
 * authenticated signed-URL 302; Google Drive kept as legacy) or text modules, plus
 * enrollments (Enrollment) with accurate anti-cheat watch progress, assign vs
 * self-enroll-with-approval, deadlines, issue reports, and feedback. A video
 * lesson can also carry timestamped QUESTIONS (utils/checkpoints): playback and
 * watch credit both stop at the first one the learner hasn't answered, and every
 * attempt is logged to CheckpointAnswer for the admin. Also admin
 * moderation of the public-course sharing (leads/comments/video feedback). Course
 * administration is gated to COURSE_ADMIN_ROLES (SuperAdmin/HRManager/LDManager).
 */
const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const Course = require('../models/Course');
const { Enrollment, CourseReport, REPORT_CATEGORIES, CourseViewer, CourseComment, VideoFeedback, CheckpointAnswer } = require('../models/Course');
const { parseDriveFileId, streamDriveFile } = require('../utils/drive');
const { normalizeCheckpoints, learnerCheckpoint, gradeAnswer, gateSec } = require('../utils/checkpoints');
const cloudinary = require('../services/cloudinary');
const { notify, notifyMany } = require('../services/notify');
const User = require('../models/User');
const { hasPermission, isPortalViewer } = require('../middleware/authMiddleware');

// Roles allowed to manage courses / assign / approve. LDManager ("HR L&D") is an
// LMS-only admin — this is the single place that gates course administration.
const COURSE_ADMIN_ROLES = ['SuperAdmin', 'HRManager', 'LDManager'];
const isCourseAdmin = (user) => user && COURSE_ADMIN_ROLES.includes(user.role);
// Who may PREVIEW a course video without an approved enrollment. Wider than
// isCourseAdmin (which also drives the notification-recipient queries, so it
// stays a plain role list): a read-only CEO/MD holds no capability in the
// catalog yet reaches the LMS admin pages through requirePermission's
// safe-method exemption, and a Manager can be granted 'courses.manage'.
const canPreviewCourse = (user) => isCourseAdmin(user) || isPortalViewer(user)
  || hasPermission(user, 'courses.manage');

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

// Normalize an incoming module list: coerce type, and validate the video source
// (a Drive link with a resolvable file id, or an uploaded R2 object key).
function normalizeModules(modules) {
  if (!Array.isArray(modules)) return [];
  return modules.map((m, i) => {
    const type = m.type === 'text' ? 'text' : 'video';
    const out = { title: (m.title || '').trim(), type, content: m.content || '', durationSec: Number(m.durationSec) || 0 };
    if (m._id) out._id = m._id; // keep stable ids on edit
    if (type === 'video') {
      // Questions live inside a video only — a timestamp means nothing on a reading.
      out.checkpoints = normalizeCheckpoints(m.checkpoints, `Lesson ${i + 1} ("${(m.title || '').trim() || 'Untitled'}")`);
      const videoSource = m.videoSource === 'cloudinary' ? 'cloudinary' : 'drive';
      out.videoSource = videoSource;
      if (videoSource === 'cloudinary') {
        const publicId = (m.cloudinaryPublicId || '').trim();
        if (!publicId) {
          const err = new Error(`Module ${i + 1} ("${out.title || 'Untitled'}"): upload a video file.`);
          err.status = 400;
          throw err;
        }
        out.cloudinaryPublicId = publicId;
        if (m.cloudinaryVersion) out.cloudinaryVersion = Number(m.cloudinaryVersion) || undefined;
        if (m.cloudinaryFormat) out.cloudinaryFormat = String(m.cloudinaryFormat).trim();
        out.cloudinaryResourceType = (m.cloudinaryResourceType || 'video').trim() || 'video';
        if (m.videoSizeBytes) out.videoSizeBytes = Number(m.videoSizeBytes) || 0;
      } else {
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
    }
    if (!out.title) {
      const err = new Error(`Module ${i + 1}: title is required.`);
      err.status = 400;
      throw err;
    }
    return out;
  });
}

// Collect the Cloudinary public ids used by a course's video modules.
function cloudinaryIdsOf(course) {
  return (course.modules || [])
    .filter((m) => m.videoSource === 'cloudinary' && m.cloudinaryPublicId)
    .map((m) => m.cloudinaryPublicId);
}

/**
 * Mint a short-lived Cloudinary upload signature for direct browser upload.
 * @route POST /api/courses/upload-signature  (course admin)
 * @returns {Object} cloud name, api key, timestamp, folder, type, signature; 503 if unconfigured
 */
// POST /api/courses/upload-signature
// Admin-only: mint a short-lived signature so the browser uploads the video
// straight to Cloudinary (the backend never buffers the file). Returns the
// cloud name, api key, timestamp, folder, type and signature.
const createUploadSignature = asyncHandler(async (req, res) => {
  if (!cloudinary.enabled()) {
    res.status(503);
    throw new Error('Video uploads are not configured. Set the CLOUDINARY_* environment variables on the server.');
  }
  res.json(cloudinary.signUpload());
});

// ===== Shared / Employee =====

/**
 * List active internal courses for the employee catalog with the caller's enrollment.
 * @route GET /api/courses
 * @returns {{count: number, courses: Object[]}} module refs stripped; external courses excluded
 */
// GET /api/courses  — active INTERNAL courses for employees, with caller's
// enrollment if any. External (public) courses are not shown in the employee
// catalog; they're reached only via their /learn/:token link.
const listCourses = asyncHandler(async (req, res) => {
  const courses = await Course.find({ active: true, courseType: { $ne: 'external' } }).sort({ createdAt: -1 }).lean();
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
// the authenticated in-portal stream endpoint, never the raw Drive URL. The
// in-video questions come through too, but only ever answer-free (see
// learnerCheckpoint) — the right answer never leaves the server.
function safeCourse(course) {
  if (!course) return course;
  const modules = (course.modules || []).map((m) => ({
    _id: m._id,
    title: m.title,
    type: m.type,
    // Source (drive/r2) is safe to expose; the actual key/link is not.
    videoSource: m.type === 'video' ? (m.videoSource || 'drive') : undefined,
    content: m.content,
    durationSec: m.durationSec,
    checkpoints: m.type === 'video' ? (m.checkpoints || []).map(learnerCheckpoint) : undefined,
  }));
  return { ...course, modules };
}

/**
 * List the caller's enrollments with their (Drive-safe) courses.
 * @route GET /api/courses/me
 * @returns {{count: number, enrollments: Object[]}} each with daysToDue/overdue meta
 */
// GET /api/courses/me — all enrollments for caller, populated with course
const myLearning = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ employee: req.user._id })
    .populate('course')
    .sort({ createdAt: -1 })
    .lean();
  const out = enrollments.map((e) => withDueMeta({ ...e, course: safeCourse(e.course) }));
  res.json({ count: out.length, enrollments: out });
});

/**
 * Employee self-enrolls in a course (created Pending approval).
 * @route POST /api/courses/:id/enroll
 * @param {string} req.params.id - course id
 * @returns {{enrollment: Object}} (201 new / 200 existing)
 * @sideeffect notifies course admins of the request
 */
// POST /api/courses/:id/enroll — employee self-enroll (needs approval)
const enroll = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course || !course.active || course.courseType === 'external') {
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
    audience: 'admin',
    title: 'Course enrollment request',
    body: `${req.user.fullName || 'An employee'} requested to enroll in "${course.title}".`,
    link: '/admin/courses?panel=approvals',
  }).catch(() => {});

  res.status(201).json({ enrollment });
});

/**
 * Stream a module's video (Cloudinary signed-URL 302 or Drive proxy).
 * @route GET /api/courses/:id/modules/:mid/video
 * @param {string} req.params.id - course id
 * @param {string} req.params.mid - module id
 * @returns {binary|302}; requires course admin (preview) or an Approved enrollment
 */
// GET /api/courses/:id/modules/:mid/video — proxy-stream the module's Drive video
const streamModuleVideo = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const module = course.modules.id(req.params.mid);
  const isCloudinary = module && module.type === 'video' && module.videoSource === 'cloudinary' && module.cloudinaryPublicId;
  const isDrive = module && module.type === 'video' && module.videoSource !== 'cloudinary' && module.driveFileId;
  if (!module || module.type !== 'video' || (!isCloudinary && !isDrive)) {
    res.status(404);
    throw new Error('Video not found');
  }

  // Access: a course admin (preview) or an employee with an Approved enrollment.
  let allowed = canPreviewCourse(req.user);
  if (!allowed) {
    const enr = await Enrollment.findOne({ course: course._id, employee: req.user._id }).select('approvalStatus').lean();
    allowed = enr && enr.approvalStatus === 'Approved';
  }
  if (!allowed) {
    res.status(403);
    throw new Error('You must be enrolled and approved to watch this video.');
  }

  if (isCloudinary) {
    // Hand the <video> a signed Cloudinary delivery URL — playback bandwidth,
    // transcoding and Range/seek handling are served by Cloudinary, not this
    // host. The browser preserves the Range header across the 302.
    const url = cloudinary.deliveryUrl(module);
    return res.redirect(302, url);
  }

  await streamDriveFile(module.driveFileId, req, res);
});

// The learner's progress row for one module, created on the enrollment if this
// is the first time they've opened it. Returns the live subdocument.
function progressFor(enrollment, moduleId) {
  let mp = enrollment.moduleProgress.find((m) => String(m.module) === String(moduleId));
  if (!mp) {
    enrollment.moduleProgress.push({ module: moduleId, watchedSec: 0, durationSec: 0, completed: false });
    mp = enrollment.moduleProgress[enrollment.moduleProgress.length - 1];
  }
  return mp;
}

// The in-video questions this learner has already got past, as a string Set.
const clearedSet = (mp) => new Set((mp?.clearedCheckpoints || []).map(String));

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

/**
 * Record watch progress on a video module; completes at ~95% watched.
 * @route PATCH /api/courses/:id/modules/:mid/progress
 * @param {string} req.params.id / req.params.mid - course/module ids
 * @param {number} req.body.watchedSec - monotonically increasing watched time
 * @param {number} req.body.durationSec - video length
 * @returns {{enrollment: Object}}; requires an Approved enrollment
 */
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

  const mp = progressFor(enrollment, module._id);
  // Watched time only ever increases; keep the best duration we've seen.
  let credited = Math.max(mp.watchedSec || 0, watchedSec);
  if (durationSec > 0) mp.durationSec = durationSec;

  // The question gate, enforced here and not only in the player: watch credit
  // stops dead at the first in-video question they haven't got past (+1s of
  // tolerance), so a patched client can't report its way through one. An
  // already-completed module is left alone — a question added later doesn't
  // retroactively un-finish somebody.
  const gate = mp.completed ? null : gateSec(module, clearedSet(mp));
  if (gate !== null) credited = Math.min(credited, gate + 1);
  mp.watchedSec = credited;

  // Complete once ~95% of a known-length video has actually been watched — and
  // never while a question is still unanswered.
  if (!mp.completed && gate === null && mp.durationSec > 0 && mp.watchedSec >= 0.95 * mp.durationSec) {
    mp.completed = true;
    mp.completedAt = new Date();
  }

  recomputeProgress(enrollment, course);
  await enrollment.save();
  res.json({ enrollment: withDueMeta(enrollment.toObject()) });
});

/**
 * Answer an in-video checkpoint question. Every attempt is logged; a correct
 * one (or any answer to an ungraded / non-blocking question) clears the gate so
 * playback and watch credit can carry on past that timestamp.
 * @route POST /api/courses/:id/modules/:mid/checkpoints/:cid/answer
 * @param {number[]} [req.body.optionIndexes] - chosen option index(es)
 * @param {string} [req.body.text] - typed answer for a `text` question
 * @returns {{correct, graded, cleared, attempt, explanation, enrollment}}
 */
// POST /api/courses/:id/modules/:mid/checkpoints/:cid/answer  { optionIndexes | text }
const answerCheckpoint = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const module = course.modules.id(req.params.mid);
  const checkpoint = module && module.checkpoints ? module.checkpoints.id(req.params.cid) : null;
  if (!checkpoint) {
    res.status(404);
    throw new Error('Question not found');
  }

  // Grading throws a 400 when nothing was answered — that IS the rule here.
  const graded = gradeAnswer(checkpoint, req.body);

  // A course admin previewing the lesson has no enrollment: let them try the
  // question, but keep their trial run out of the learners' log.
  const enrollment = await Enrollment.findOne({ course: course._id, employee: req.user._id });
  if (!enrollment && canPreviewCourse(req.user)) {
    return res.json({ ...graded, attempt: 0, preview: true, explanation: checkpoint.explanation || '' });
  }
  if (!enrollment) {
    res.status(404);
    throw new Error('Enrollment not found');
  }
  if (enrollment.approvalStatus !== 'Approved') {
    res.status(403);
    throw new Error('Your enrollment is not approved yet.');
  }

  const attempt = 1 + await CheckpointAnswer.countDocuments({
    checkpoint: checkpoint._id,
    employee: req.user._id,
  });
  await CheckpointAnswer.create({
    course: course._id,
    module: module._id,
    moduleTitle: module.title,
    checkpoint: checkpoint._id,
    question: checkpoint.question,
    atSec: checkpoint.atSec,
    audience: 'employee',
    employee: req.user._id,
    answeredBy: req.user.fullName || req.user.email,
    answer: graded.answer,
    graded: graded.graded,
    correct: graded.correct,
    cleared: graded.cleared,
    attempt,
  });

  if (graded.cleared) {
    const mp = progressFor(enrollment, module._id);
    if (!clearedSet(mp).has(String(checkpoint._id))) mp.clearedCheckpoints.push(checkpoint._id);
    await enrollment.save();
  }

  res.json({
    ...graded,
    attempt,
    // Only worth showing once they're past it — until then it could give the answer away.
    explanation: graded.cleared ? (checkpoint.explanation || '') : '',
    enrollment: withDueMeta(enrollment.toObject()),
  });
});

/**
 * Mark (or unmark) a text module as read.
 * @route POST /api/courses/:id/modules/:mid/complete
 * @param {string} req.params.id / req.params.mid - course/module ids
 * @param {boolean} [req.body.completed=true]
 * @returns {{enrollment: Object}}; requires an Approved enrollment
 */
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

/**
 * Employee reports an issue about a lesson (video/audio/playback…).
 * @route POST /api/courses/:id/report
 * @param {string} req.params.id - course id
 * @param {string} [req.body.module] - module id
 * @param {string} [req.body.category] - one of REPORT_CATEGORIES
 * @param {string} [req.body.note]
 * @returns {{report: Object}} (201)
 * @sideeffect notifies course admins; requires an Approved enrollment
 */
// POST /api/courses/:id/report  { module?, category, note }
// Employee raises an issue about a lesson (video quality, audio, playback…).
const reportIssue = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const enrollment = await getApprovedEnrollment(course._id, req.user._id, res);

  let moduleTitle;
  if (req.body.module) {
    const m = course.modules.id(req.body.module);
    if (m) moduleTitle = m.title;
  }
  const category = REPORT_CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';

  const report = await CourseReport.create({
    course: course._id,
    module: req.body.module || undefined,
    moduleTitle,
    employee: req.user._id,
    category,
    note: (req.body.note || '').slice(0, 2000),
  });

  const admins = await User.find({ role: { $in: COURSE_ADMIN_ROLES }, isActive: true }).select('_id').lean();
  notifyMany(admins.map((a) => a._id), {
    type: 'course',
    audience: 'admin',
    title: 'Course issue reported',
    body: `${req.user.fullName || 'An employee'} reported "${category}" on "${course.title}"${moduleTitle ? ` - ${moduleTitle}` : ''}.`,
    link: '/admin/courses?panel=reports',
  }).catch(() => {});

  // Touch enrollment so we know the learner interacted (keeps updatedAt fresh).
  void enrollment;
  res.status(201).json({ report });
});

/**
 * Submit a 1-5 rating and comment for a course the caller is enrolled in.
 * @route POST /api/courses/:id/feedback
 * @param {string} req.params.id - course id
 * @param {number} req.body.rating - 1-5 (required)
 * @param {string} [req.body.comment]
 * @returns {{enrollment: Object}}
 * @sideeffect notifies course admins; requires an Approved enrollment
 */
// POST /api/courses/:id/feedback  { rating, comment }
const submitFeedback = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const enrollment = await getApprovedEnrollment(course._id, req.user._id, res);

  const rating = Math.round(Number(req.body.rating));
  if (!(rating >= 1 && rating <= 5)) {
    res.status(400);
    throw new Error('Rating must be between 1 and 5.');
  }
  enrollment.feedback = {
    rating,
    comment: (req.body.comment || '').slice(0, 2000),
    submittedAt: new Date(),
  };
  await enrollment.save();

  const admins = await User.find({ role: { $in: COURSE_ADMIN_ROLES }, isActive: true }).select('_id').lean();
  notifyMany(admins.map((a) => a._id), {
    type: 'course',
    audience: 'admin',
    title: 'Course feedback received',
    body: `${req.user.fullName || 'An employee'} rated "${course.title}" ${rating}/5.`,
    link: '/admin/courses',
  }).catch(() => {});

  res.json({ enrollment: withDueMeta(enrollment.toObject()) });
});

// ===== Admin =====

/**
 * List employee-raised course issue reports, optionally by status.
 * @route GET /api/courses/reports?status=  (admin)
 * @param {string} [req.query.status] - 'Open' or 'Resolved'
 * @returns {{count: number, reports: Object[]}}
 */
// GET /api/courses/reports?status=Open — course issues raised by employees
const listReports = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && ['Open', 'Resolved'].includes(req.query.status)) filter.status = req.query.status;
  const reports = await CourseReport.find(filter)
    .populate('course', 'title')
    .populate('employee', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ count: reports.length, reports });
});

/**
 * Resolve (or reopen) a course issue report.
 * @route PATCH /api/courses/reports/:rid/resolve  (admin)
 * @param {string} req.params.rid - report id
 * @param {string} [req.body.status] - 'Open' to reopen, else Resolved
 * @returns {{report: Object}}
 */
// PATCH /api/courses/reports/:rid/resolve
const resolveReport = asyncHandler(async (req, res) => {
  const report = await CourseReport.findById(req.params.rid);
  if (!report) {
    res.status(404);
    throw new Error('Report not found');
  }
  report.status = req.body.status === 'Open' ? 'Open' : 'Resolved';
  await report.save();
  res.json({ report });
});

/**
 * List every course (incl. inactive) with enrollment/completion/overdue and
 * open-report / pending-comment counts.
 * @route GET /api/courses/admin/all  (admin)
 * @returns {{count: number, courses: Object[]}}
 */
// GET /api/courses/admin/all — all courses incl inactive, with enrollment counts
const listAdmin = asyncHandler(async (req, res) => {
  const courses = await Course.find().sort({ createdAt: -1 }).lean();
  const withCounts = await Promise.all(
    courses.map(async (c) => {
      const [enrollments, openReports, pendingComments] = await Promise.all([
        Enrollment.find({ course: c._id }).select('status approvalStatus dueDate').lean(),
        CourseReport.countDocuments({ course: c._id, status: 'Open' }),
        CourseComment.countDocuments({ course: c._id, status: 'Pending' }),
      ]);
      const approved = enrollments.filter((e) => e.approvalStatus === 'Approved');
      const overdue = approved.filter(
        (e) => e.dueDate && e.status !== 'Completed' && new Date(e.dueDate).getTime() < Date.now()
      ).length;
      return {
        ...c,
        moduleCount: (c.modules || []).length,
        videoCount: (c.modules || []).filter((m) => m.type !== 'text').length,
        questionCount: (c.modules || []).reduce((n, m) => n + (m.checkpoints || []).length, 0),
        enrollmentCount: approved.length,
        completedCount: approved.filter((e) => e.status === 'Completed').length,
        pendingCount: enrollments.filter((e) => e.approvalStatus === 'Pending').length,
        overdueCount: overdue,
        openReportsCount: openReports,
        pendingCommentsCount: pendingComments,
      };
    })
  );
  res.json({ count: withCounts.length, courses: withCounts });
});

// An external course is public: ensure it has a token and isPublic; an internal
// course is never public. Keeps courseType the single source of truth.
function applyCourseType(course, courseType) {
  course.courseType = courseType === 'external' ? 'external' : 'internal';
  if (course.courseType === 'external') {
    course.isPublic = true;
    if (!course.publicToken) course.publicToken = crypto.randomBytes(16).toString('hex');
  } else {
    course.isPublic = false;
  }
}

/**
 * Create a course with normalized modules.
 * @route POST /api/courses  (admin)
 * @param {string} req.body.title - required
 * @param {Array} [req.body.modules] - video (Cloudinary/Drive) or text modules
 * @param {string} [req.body.courseType] - 'external' makes it public with a token
 * @returns {{course: Object}} (201)
 */
// POST /api/courses
const createCourse = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const modules = normalizeModules(req.body.modules);
  const course = new Course({
    title: req.body.title,
    description: req.body.description,
    category: req.body.category,
    durationHours: Number(req.body.durationHours) || 0,
    deadlineDays: Number(req.body.deadlineDays) || 0,
    active: req.body.active !== false,
    modules,
    createdBy: req.user._id,
  });
  applyCourseType(course, req.body.courseType);
  await course.save();
  res.status(201).json({ course });
});

/**
 * Update a course (partial); deletes Cloudinary assets orphaned by module edits.
 * @route PUT /api/courses/:id  (admin)
 * @param {string} req.params.id - course id
 * @param {Object} req.body - title/description/category/durationHours/deadlineDays/active/courseType/modules
 * @returns {{course: Object}}
 * @sideeffect best-effort destroy of removed Cloudinary videos
 */
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
  if (req.body.courseType !== undefined) applyCourseType(course, req.body.courseType);
  let orphanedIds = [];
  if (req.body.modules !== undefined) {
    const before = new Set(cloudinaryIdsOf(course));
    course.modules = normalizeModules(req.body.modules);
    const after = new Set(cloudinaryIdsOf(course));
    // Any Cloudinary video removed or replaced during this edit is now orphaned.
    orphanedIds = [...before].filter((id) => !after.has(id));
  }
  await course.save();
  // Delete orphaned assets after the save succeeds (best-effort).
  orphanedIds.forEach((id) => cloudinary.destroy(id));
  res.json({ course });
});

/**
 * Delete a course plus all its enrollments, reports, viewers, comments and feedback.
 * @route DELETE /api/courses/:id  (admin)
 * @param {string} req.params.id - course id
 * @returns {{id: string, deleted: boolean}}
 * @sideeffect best-effort destroy of the course's Cloudinary videos
 */
// DELETE /api/courses/:id — also remove enrollments
const deleteCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const ids = cloudinaryIdsOf(course);
  await Enrollment.deleteMany({ course: course._id });
  await CheckpointAnswer.deleteMany({ course: course._id });
  await CourseReport.deleteMany({ course: course._id });
  await CourseViewer.deleteMany({ course: course._id });
  await CourseComment.deleteMany({ course: course._id });
  await VideoFeedback.deleteMany({ course: course._id });
  await course.deleteOne();
  ids.forEach((id) => cloudinary.destroy(id)); // free the Cloudinary assets (best-effort)
  res.json({ id: req.params.id, deleted: true });
});

// Compute a due date from an explicit value or the course's deadlineDays.
function computeDueDate(course, explicit) {
  if (explicit) return new Date(explicit);
  if (course.deadlineDays > 0) return new Date(Date.now() + course.deadlineDays * 86400000);
  return undefined;
}

/**
 * Assign a course to employees (auto-Approved enrollments) with an optional due date.
 * @route POST /api/courses/:id/assign  (admin)
 * @param {string} req.params.id - course id
 * @param {string[]} req.body.employeeIds - at least one
 * @param {string} [req.body.dueDate] - else derived from the course deadlineDays
 * @returns {{assigned: number}} (201)
 * @sideeffect notifies each assigned employee
 */
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
    audience: 'employee',
    title: 'New course assigned',
    body: `You've been assigned "${course.title}"${dueDate ? ` - due ${dueDate.toLocaleDateString('en-IN')}` : ''}.`,
    link: `/employee/learning/${course._id}`,
  }).catch(() => {});

  res.status(201).json({ assigned: results.length });
});

/**
 * List self-enroll requests awaiting approval.
 * @route GET /api/courses/enrollments/pending  (admin)
 * @returns {{count: number, enrollments: Object[]}}
 */
// GET /api/courses/enrollments/pending — self-enroll requests awaiting approval
const listPending = asyncHandler(async (req, res) => {
  const pending = await Enrollment.find({ approvalStatus: 'Pending' })
    .populate('course', 'title category')
    .populate('employee', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ count: pending.length, enrollments: pending });
});

/**
 * List the enrollment roster for one course.
 * @route GET /api/courses/:id/enrollments  (admin)
 * @param {string} req.params.id - course id
 * @returns {{count: number, enrollments: Object[]}} with due meta
 */
// GET /api/courses/:id/enrollments — roster for one course
const courseRoster = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ course: req.params.id })
    .populate('employee', 'firstName lastName email')
    .sort({ createdAt: -1 })
    .lean();
  res.json({ count: enrollments.length, enrollments: enrollments.map(withDueMeta) });
});

/**
 * Approve a pending self-enrollment, optionally setting a due date.
 * @route PATCH /api/courses/enrollments/:eid/approve  (admin)
 * @param {string} req.params.eid - enrollment id
 * @param {string} [req.body.dueDate] - else derived from the course deadlineDays
 * @returns {{enrollment: Object}}
 * @sideeffect notifies the employee
 */
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
    audience: 'employee',
    title: 'Enrollment approved',
    body: `Your enrollment in "${enrollment.course.title}" was approved.`,
    link: `/employee/learning/${enrollment.course._id}`,
  }).catch(() => {});

  res.json({ enrollment });
});

/**
 * Reject a pending self-enrollment.
 * @route PATCH /api/courses/enrollments/:eid/reject  (admin)
 * @param {string} req.params.eid - enrollment id
 * @returns {{enrollment: Object}}
 * @sideeffect notifies the employee
 */
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
    audience: 'employee',
    title: 'Enrollment declined',
    body: `Your request to enroll in "${enrollment.course.title}" was declined.`,
    link: '/employee/learning',
  }).catch(() => {});

  res.json({ enrollment });
});

// ===== Public sharing + moderation (admin) =====

/**
 * Toggle public sharing for a course (mints a stable publicToken on first enable).
 * @route POST /api/courses/:id/public  (admin)
 * @param {string} req.params.id - course id
 * @param {boolean} [req.body.enabled=true]
 * @returns {{isPublic, publicToken}}
 */
// POST /api/courses/:id/public  { enabled } — turn public sharing on/off.
// Mints a stable publicToken on first enable (kept across toggles).
const setCoursePublic = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const enabled = req.body.enabled !== false;
  course.isPublic = enabled;
  if (enabled && !course.publicToken) course.publicToken = crypto.randomBytes(16).toString('hex');
  await course.save();
  res.json({ isPublic: course.isPublic, publicToken: course.publicToken });
});

/**
 * List public viewers (leads) who registered for a course (max 2000).
 * @route GET /api/courses/:id/leads  (admin)
 * @param {string} req.params.id - course id
 * @returns {{count: number, leads: Object[]}}
 */
// GET /api/courses/:id/leads — public viewers who filled the lead form
const listCourseLeads = asyncHandler(async (req, res) => {
  const leads = await CourseViewer.find({ course: req.params.id }).sort({ createdAt: -1 }).limit(2000).lean();
  res.json({ count: leads.length, leads });
});

/**
 * List public course comments across all courses for moderation (max 1000).
 * @route GET /api/courses/comments?status=  (admin)
 * @param {string} [req.query.status] - Pending/Approved/Rejected
 * @returns {{count: number, comments: Object[]}}
 */
// GET /api/courses/comments?status= — comments across all courses for moderation
const listAllComments = asyncHandler(async (req, res) => {
  const filter = {};
  if (['Pending', 'Approved', 'Rejected'].includes(req.query.status)) filter.status = req.query.status;
  const comments = await CourseComment.find(filter)
    .populate('course', 'title')
    .sort({ createdAt: -1 })
    .limit(1000)
    .lean();
  res.json({ count: comments.length, comments });
});

/**
 * Moderate a public course comment (approve/reject/re-pending).
 * @route PATCH /api/courses/comments/:cid  (admin)
 * @param {string} req.params.cid - comment id
 * @param {string} [req.body.status] - Pending/Approved/Rejected (default Approved)
 * @returns {{comment: Object}}
 */
// PATCH /api/courses/comments/:cid  { status } — approve / reject / re-pending
const moderateComment = asyncHandler(async (req, res) => {
  const comment = await CourseComment.findById(req.params.cid);
  if (!comment) {
    res.status(404);
    throw new Error('Comment not found');
  }
  comment.status = ['Pending', 'Approved', 'Rejected'].includes(req.body.status) ? req.body.status : 'Approved';
  await comment.save();
  res.json({ comment });
});

/**
 * Delete a public course comment.
 * @route DELETE /api/courses/comments/:cid  (admin)
 * @param {string} req.params.cid - comment id
 * @returns {{id: string, deleted: boolean}}
 */
// DELETE /api/courses/comments/:cid
const deleteComment = asyncHandler(async (req, res) => {
  const comment = await CourseComment.findById(req.params.cid);
  if (!comment) {
    res.status(404);
    throw new Error('Comment not found');
  }
  await comment.deleteOne();
  res.json({ id: req.params.cid, deleted: true });
});

/**
 * The in-video question log for one course: every answer anyone has given, plus
 * a per-question roll-up (how many answered, how many got it right).
 * @route GET /api/courses/:id/checkpoint-answers?module=&only=  (admin)
 * @param {string} req.params.id - course id
 * @param {string} [req.query.module] - limit to one lesson
 * @param {string} [req.query.only] - 'wrong' | 'correct'
 * @returns {{count, answers, questions}} answers newest first (max 3000)
 */
// GET /api/courses/:id/checkpoint-answers — who answered what, per question
const listCheckpointAnswers = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const filter = { course: course._id };
  if (req.query.module) filter.module = req.query.module;
  if (req.query.only === 'wrong') filter.correct = false;
  else if (req.query.only === 'correct') filter.correct = true;

  const answers = await CheckpointAnswer.find(filter)
    .populate('employee', 'firstName lastName email')
    .populate('viewer', 'name phone email location')
    .sort({ createdAt: -1 })
    .limit(3000)
    .lean();

  // Roll-up per question, over EVERY answer (not the filtered slice, and not
  // the 3000-row page) so the numbers don't move under a filter: the first
  // attempt per person is the score, later attempts are retries. Fetched raw
  // rather than reusing `answers` — those are POPULATED, so `a.employee` is a
  // document and would stringify to "[object Object]" for everyone alike,
  // collapsing the whole cohort into one person.
  const all = await CheckpointAnswer.find({ course: course._id })
    .select('checkpoint employee viewer correct attempt')
    .lean();
  const stats = new Map();
  all.forEach((a) => {
    const key = String(a.checkpoint);
    const s = stats.get(key) || { attempts: 0, people: new Set(), firstRight: 0, everRight: new Set() };
    s.attempts += 1;
    // Lean rows, so these are plain ObjectIds. A row with neither (shouldn't
    // happen) counts as its own person rather than merging with every other.
    const who = String(a.employee || a.viewer || a._id);
    s.people.add(who);
    if (a.attempt === 1 && a.correct) s.firstRight += 1;
    if (a.correct) s.everRight.add(who);
    stats.set(key, s);
  });

  const questions = [];
  (course.modules || []).forEach((m) => {
    (m.checkpoints || []).forEach((c) => {
      const s = stats.get(String(c._id));
      questions.push({
        _id: c._id,
        module: m._id,
        moduleTitle: m.title,
        atSec: c.atSec,
        question: c.question,
        type: c.type,
        options: (c.options || []).map((o) => ({ text: o.text, correct: !!o.correct })),
        graded: (c.options || []).some((o) => o.correct),
        answeredBy: s ? s.people.size : 0,
        attempts: s ? s.attempts : 0,
        firstTimeRight: s ? s.firstRight : 0,
        eventuallyRight: s ? s.everRight.size : 0,
      });
    });
  });

  res.json({ count: answers.length, answers, questions });
});

/**
 * List public per-video feedback for a course (max 2000).
 * @route GET /api/courses/:id/video-feedback  (admin)
 * @param {string} req.params.id - course id
 * @returns {{count: number, feedback: Object[]}} with populated viewer
 */
// GET /api/courses/:id/video-feedback — public per-video feedback for a course
const listVideoFeedback = asyncHandler(async (req, res) => {
  const feedback = await VideoFeedback.find({ course: req.params.id })
    .populate('viewer', 'name phone location email')
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean();
  res.json({ count: feedback.length, feedback });
});

module.exports = {
  listCourses,
  myLearning,
  setCoursePublic,
  listCourseLeads,
  listAllComments,
  moderateComment,
  deleteComment,
  listVideoFeedback,
  enroll,
  streamModuleVideo,
  updateModuleProgress,
  answerCheckpoint,
  listCheckpointAnswers,
  completeTextModule,
  reportIssue,
  submitFeedback,
  listAdmin,
  createUploadSignature,
  createCourse,
  updateCourse,
  deleteCourse,
  assignCourse,
  listPending,
  courseRoster,
  approveEnrollment,
  rejectEnrollment,
  listReports,
  resolveReport,
};
