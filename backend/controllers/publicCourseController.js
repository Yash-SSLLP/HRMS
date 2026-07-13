// Public (no-login) course viewer. Anyone with a course's publicToken can:
//   - view the course after filling a short lead form (name/phone/location[/email])
//   - stream its videos (tied to their lead session, no account)
//   - read APPROVED comments and post their own (held for admin approval)
//   - submit per-video feedback (rating + fixed questions)
// All endpoints here are unauthenticated — access is gated by the course being
// public and, for writes/streaming, a valid viewer sessionToken.
const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const Course = require('../models/Course');
const { CourseViewer, CourseComment, VideoFeedback, VIDEO_FEEDBACK_QUESTIONS } = require('../models/Course');
const { streamDriveFile } = require('../utils/drive');
const cloudinary = require('../services/cloudinary');
const { notifyMany } = require('../services/notify');
const User = require('../models/User');

const COURSE_ADMIN_ROLES = ['SuperAdmin', 'HRManager', 'LDManager'];

// Strip all private video refs — a public viewer reaches video only through the
// tokenised stream endpoint, never a raw Drive/Cloudinary URL.
function publicSafeCourse(course) {
  return {
    _id: course._id,
    title: course.title,
    description: course.description,
    category: course.category,
    durationHours: course.durationHours,
    modules: (course.modules || []).map((m) => ({
      _id: m._id,
      title: m.title,
      type: m.type,
      videoSource: m.type === 'video' ? (m.videoSource || 'drive') : undefined,
      content: m.content,
      durationSec: m.durationSec,
    })),
  };
}

// Look up a public course by its token, or 404.
async function findPublicCourse(token, res) {
  const course = await Course.findOne({ publicToken: token, isPublic: true });
  if (!course) {
    res.status(404);
    throw new Error('This course link is invalid or is no longer public.');
  }
  return course;
}

// Load the viewer by sessionToken for a given course, or 401.
async function requireViewer(course, sessionToken, res) {
  const viewer = sessionToken
    ? await CourseViewer.findOne({ course: course._id, sessionToken })
    : null;
  if (!viewer) {
    res.status(401);
    throw new Error('Please fill the form to watch this course.');
  }
  return viewer;
}

// GET /api/public/courses/:token — course + feedback questions (no video refs)
const getPublicCourse = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.token, res);
  res.json({ course: publicSafeCourse(course), feedbackQuestions: VIDEO_FEEDBACK_QUESTIONS });
});

// POST /api/public/courses/:token/register  { name, phone, location, email? }
const registerViewer = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.token, res);
  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const location = (req.body.location || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  if (!name || !phone || !location) {
    res.status(400);
    throw new Error('Name, phone and location are required.');
  }
  if (!/[0-9]{6,}/.test(phone.replace(/\D/g, ''))) {
    res.status(400);
    throw new Error('Please enter a valid phone number.');
  }
  const viewer = await CourseViewer.create({
    course: course._id,
    name: name.slice(0, 120),
    phone: phone.slice(0, 30),
    location: location.slice(0, 120),
    email: email.slice(0, 160) || undefined,
    sessionToken: crypto.randomBytes(24).toString('hex'),
    lastSeenAt: new Date(),
  });
  res.status(201).json({ sessionToken: viewer.sessionToken, viewer: { name: viewer.name } });
});

// GET /api/public/courses/:token/modules/:mid/video?viewer=<sessionToken>
const streamPublicVideo = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.token, res);
  await requireViewer(course, req.query.viewer, res);

  const module = course.modules.id(req.params.mid);
  const isCloudinary = module && module.type === 'video' && module.videoSource === 'cloudinary' && module.cloudinaryPublicId;
  const isDrive = module && module.type === 'video' && module.videoSource !== 'cloudinary' && module.driveFileId;
  if (!module || module.type !== 'video' || (!isCloudinary && !isDrive)) {
    res.status(404);
    throw new Error('Video not found');
  }
  if (isCloudinary) {
    return res.redirect(302, cloudinary.deliveryUrl(module));
  }
  await streamDriveFile(module.driveFileId, req, res);
});

// GET /api/public/courses/:token/comments?module=<mid> — approved comments only
const listPublicComments = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.token, res);
  const filter = { course: course._id, status: 'Approved' };
  if (req.query.module) filter.module = req.query.module;
  const comments = await CourseComment.find(filter)
    .select('name text module moduleTitle createdAt')
    .sort({ createdAt: -1 })
    .limit(300)
    .lean();
  res.json({ count: comments.length, comments });
});

// POST /api/public/courses/:token/comments  { viewer, module?, text }
const postPublicComment = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.token, res);
  const viewer = await requireViewer(course, req.body.viewer, res);
  const text = (req.body.text || '').trim();
  if (!text) {
    res.status(400);
    throw new Error('Comment cannot be empty.');
  }
  let moduleTitle;
  if (req.body.module) {
    const m = course.modules.id(req.body.module);
    if (m) moduleTitle = m.title;
  }
  const comment = await CourseComment.create({
    course: course._id,
    module: req.body.module || undefined,
    moduleTitle,
    viewer: viewer._id,
    name: viewer.name,
    text: text.slice(0, 2000),
    status: 'Pending',
  });

  const admins = await User.find({ role: { $in: COURSE_ADMIN_ROLES }, isActive: true }).select('_id').lean();
  notifyMany(admins.map((a) => a._id), {
    type: 'course',
    audience: 'admin',
    title: 'New course comment to review',
    body: `${viewer.name} commented on "${course.title}"${moduleTitle ? ` - ${moduleTitle}` : ''}.`,
    link: `/admin/courses?panel=comments`,
  }).catch(() => {});

  // Don't return the pending comment content back as "live" — it isn't shown yet.
  res.status(201).json({ ok: true, pending: true, id: comment._id });
});

// POST /api/public/courses/:token/feedback  { viewer, module, rating, answers, comment }
const postPublicFeedback = asyncHandler(async (req, res) => {
  const course = await findPublicCourse(req.params.token, res);
  const viewer = await requireViewer(course, req.body.viewer, res);

  let moduleTitle;
  if (req.body.module) {
    const m = course.modules.id(req.body.module);
    if (m) moduleTitle = m.title;
  }
  const rating = Math.round(Number(req.body.rating));
  const validRating = rating >= 1 && rating <= 5 ? rating : undefined;

  // Keep only answers to the known fixed questions.
  const byKey = new Map(VIDEO_FEEDBACK_QUESTIONS.map((q) => [q.key, q]));
  const answers = Array.isArray(req.body.answers)
    ? req.body.answers
        .filter((a) => a && byKey.has(a.key))
        .map((a) => ({ key: a.key, label: byKey.get(a.key).label, answer: String(a.answer || '').slice(0, 120) }))
    : [];

  const feedback = await VideoFeedback.create({
    course: course._id,
    module: req.body.module || undefined,
    moduleTitle,
    viewer: viewer._id,
    rating: validRating,
    answers,
    comment: (req.body.comment || '').slice(0, 2000),
  });
  res.status(201).json({ ok: true, id: feedback._id });
});

module.exports = {
  getPublicCourse,
  registerViewer,
  streamPublicVideo,
  listPublicComments,
  postPublicComment,
  postPublicFeedback,
};
