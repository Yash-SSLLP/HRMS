// Public (no-login) course endpoints, mounted at /api/public/courses.
// None of these use `protect` — access is gated by the course's publicToken and,
// for writes/streaming, a viewer sessionToken issued by /register.
const express = require('express');
const {
  getPublicCourse,
  registerViewer,
  streamPublicVideo,
  listPublicComments,
  postPublicComment,
  postPublicFeedback,
} = require('../controllers/publicCourseController');

const router = express.Router();

router.get('/:token', getPublicCourse);
router.post('/:token/register', registerViewer);
router.get('/:token/modules/:mid/video', streamPublicVideo);
router.get('/:token/comments', listPublicComments);
router.post('/:token/comments', postPublicComment);
router.post('/:token/feedback', postPublicFeedback);

module.exports = router;
