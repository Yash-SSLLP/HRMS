/**
 * Course router — mounted at /api/courses.
 * LMS: employee learning (browse/enroll/stream/progress/report) plus
 * L&D/HR admin course management, moderation, and public sharing.
 * Video stream uses protectMedia (header or ?access_token); the rest
 * require header auth (router.use(protect)).
 */
const express = require('express');
const {
  listCourses,
  myLearning,
  enroll,
  streamModuleVideo,
  updateModuleProgress,
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
  setCoursePublic,
  listCourseLeads,
  listAllComments,
  moderateComment,
  deleteComment,
  listVideoFeedback,
} = require('../controllers/courseController');
const { protect, protectMedia, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Video stream is authenticated via header OR ?access_token= (a <video> element
// can't send an Authorization header). Registered before the header-only
// `protect` guard below so it isn't shadowed by it.
// GET /:id/modules/:mid/video — stream a module video; protectMedia (header or ?access_token).
router.get('/:id/modules/:mid/video', protectMedia, streamModuleVideo);

router.use(protect);

// Employee / shared
// GET / — list courses; protected.
router.get('/', listCourses);
// GET /me — current user's learning/enrollments; protected.
router.get('/me', myLearning);
// POST /:id/enroll — self-enroll in a course; protected.
router.post('/:id/enroll', enroll);
// PATCH /:id/modules/:mid/progress — update watch progress; protected.
router.patch('/:id/modules/:mid/progress', updateModuleProgress);
// POST /:id/modules/:mid/complete — mark a text module complete; protected.
router.post('/:id/modules/:mid/complete', completeTextModule);
// POST /:id/report — report an issue with a course; protected.
router.post('/:id/report', reportIssue);
// POST /:id/feedback — submit course feedback; protected.
router.post('/:id/feedback', submitFeedback);

// Admin-only. requirePermission('courses.manage') covers SuperAdmin (all),
// LDManager (mapped to courses.manage), and any HRManager granted the capability.
router.use(requirePermission('courses.manage'));
// GET /admin/all — list all courses (admin); protected, requires 'courses.manage'.
router.get('/admin/all', listAdmin);
// POST /upload-signature — signed Cloudinary upload params; protected, requires 'courses.manage'.
router.post('/upload-signature', createUploadSignature);
// GET /enrollments/pending — enrollments awaiting approval; protected, requires 'courses.manage'.
router.get('/enrollments/pending', listPending);
// GET /reports — course issue reports; protected, requires 'courses.manage'.
router.get('/reports', listReports);
// PATCH /reports/:rid/resolve — resolve an issue report; protected, requires 'courses.manage'.
router.patch('/reports/:rid/resolve', resolveReport);
// PATCH /enrollments/:eid/approve — approve an enrollment; protected, requires 'courses.manage'.
router.patch('/enrollments/:eid/approve', approveEnrollment);
// PATCH /enrollments/:eid/reject — reject an enrollment; protected, requires 'courses.manage'.
router.patch('/enrollments/:eid/reject', rejectEnrollment);
// POST / — create a course; protected, requires 'courses.manage'.
router.post('/', createCourse);
// POST /:id/assign — assign a course to employees; protected, requires 'courses.manage'.
router.post('/:id/assign', assignCourse);
// GET /:id/enrollments — course roster; protected, requires 'courses.manage'.
router.get('/:id/enrollments', courseRoster);
// Public sharing + moderation
// GET /comments — list all comments for moderation; protected, requires 'courses.manage'.
router.get('/comments', listAllComments);
// PATCH /comments/:cid — moderate a comment; protected, requires 'courses.manage'.
router.patch('/comments/:cid', moderateComment);
// DELETE /comments/:cid — delete a comment; protected, requires 'courses.manage'.
router.delete('/comments/:cid', deleteComment);
// POST /:id/public — toggle public sharing of a course; protected, requires 'courses.manage'.
router.post('/:id/public', setCoursePublic);
// GET /:id/leads — public-viewer leads for a course; protected, requires 'courses.manage'.
router.get('/:id/leads', listCourseLeads);
// GET /:id/video-feedback — video feedback for a course; protected, requires 'courses.manage'.
router.get('/:id/video-feedback', listVideoFeedback);
// PUT /:id — update a course; protected, requires 'courses.manage'.
router.put('/:id', updateCourse);
// DELETE /:id — delete a course; protected, requires 'courses.manage'.
router.delete('/:id', deleteCourse);

module.exports = router;
