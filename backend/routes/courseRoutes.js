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
} = require('../controllers/courseController');
const { protect, protectMedia, restrictTo } = require('../middleware/authMiddleware');

// Roles allowed to administer courses. Keep in sync with COURSE_ADMIN_ROLES in
// the controller. LDManager ("HR L&D") is an LMS-only admin.
const COURSE_ADMIN_ROLES = ['SuperAdmin', 'HRManager', 'LDManager'];

const router = express.Router();

// Video stream is authenticated via header OR ?access_token= (a <video> element
// can't send an Authorization header). Registered before the header-only
// `protect` guard below so it isn't shadowed by it.
router.get('/:id/modules/:mid/video', protectMedia, streamModuleVideo);

router.use(protect);

// Employee / shared
router.get('/', listCourses);
router.get('/me', myLearning);
router.post('/:id/enroll', enroll);
router.patch('/:id/modules/:mid/progress', updateModuleProgress);
router.post('/:id/modules/:mid/complete', completeTextModule);
router.post('/:id/report', reportIssue);
router.post('/:id/feedback', submitFeedback);

// Admin-only (HR / SuperAdmin / L&D later)
router.use(restrictTo(...COURSE_ADMIN_ROLES));
router.get('/admin/all', listAdmin);
router.get('/enrollments/pending', listPending);
router.get('/reports', listReports);
router.patch('/reports/:rid/resolve', resolveReport);
router.patch('/enrollments/:eid/approve', approveEnrollment);
router.patch('/enrollments/:eid/reject', rejectEnrollment);
router.post('/', createCourse);
router.post('/:id/assign', assignCourse);
router.get('/:id/enrollments', courseRoster);
router.put('/:id', updateCourse);
router.delete('/:id', deleteCourse);

module.exports = router;
