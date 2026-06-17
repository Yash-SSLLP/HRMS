const asyncHandler = require('express-async-handler');
const Course = require('../models/Course');
const { Enrollment } = require('../models/Course');

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
      enrollment: e ? { status: e.status, progress: e.progress } : null,
    };
  });
  res.json({ count: withEnrollment.length, courses: withEnrollment });
});

// POST /api/courses/:id/enroll
const enroll = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const existing = await Enrollment.findOne({ course: course._id, employee: req.user._id });
  if (existing) {
    return res.status(200).json({ enrollment: existing });
  }
  const enrollment = await Enrollment.create({ course: course._id, employee: req.user._id });
  res.status(201).json({ enrollment });
});

// PATCH /api/courses/:id/progress  { completedModules: [indices] }
const updateProgress = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  const enrollment = await Enrollment.findOne({ course: course._id, employee: req.user._id });
  if (!enrollment) {
    res.status(404);
    throw new Error('Enrollment not found');
  }

  const completedModules = Array.isArray(req.body.completedModules) ? req.body.completedModules : [];
  enrollment.completedModules = completedModules;

  const total = course.modules.length;
  const progress = total === 0 ? 100 : Math.round((completedModules.length / total) * 100);
  enrollment.progress = progress;

  if (progress >= 100) {
    enrollment.status = 'Completed';
    enrollment.completedAt = new Date();
  } else if (progress > 0) {
    enrollment.status = 'InProgress';
    enrollment.completedAt = undefined;
  } else {
    enrollment.status = 'Enrolled';
    enrollment.completedAt = undefined;
  }

  await enrollment.save();
  res.json({ enrollment });
});

// GET /api/courses/me — all enrollments for caller, populated with course
const myLearning = asyncHandler(async (req, res) => {
  const enrollments = await Enrollment.find({ employee: req.user._id })
    .populate('course')
    .sort({ createdAt: -1 });
  res.json({ count: enrollments.length, enrollments });
});

// ===== Admin =====

// GET /api/courses/admin/all — all courses incl inactive, with enrollment counts
const listAdmin = asyncHandler(async (req, res) => {
  const courses = await Course.find().sort({ createdAt: -1 }).lean();
  const withCounts = await Promise.all(
    courses.map(async (c) => {
      const enrollmentCount = await Enrollment.countDocuments({ course: c._id });
      const completedCount = await Enrollment.countDocuments({ course: c._id, status: 'Completed' });
      return { ...c, enrollmentCount, completedCount };
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
  const course = await Course.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ course });
});

// PUT /api/courses/:id
const updateCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) {
    res.status(404);
    throw new Error('Course not found');
  }
  delete req.body.createdBy;
  Object.assign(course, req.body);
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

module.exports = {
  listCourses,
  enroll,
  updateProgress,
  myLearning,
  listAdmin,
  createCourse,
  updateCourse,
  deleteCourse,
};
