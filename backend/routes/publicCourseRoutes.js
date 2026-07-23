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

// GET /:token — fetch a publicly-shared course; public (publicToken-gated).
router.get('/:token', getPublicCourse);
// POST /:token/register — register a public viewer, issues a sessionToken; public.
router.post('/:token/register', registerViewer);
// GET /:token/modules/:mid/video — stream a module video; public (sessionToken-gated).
router.get('/:token/modules/:mid/video', streamPublicVideo);
// GET /:token/comments — list public course comments; public.
router.get('/:token/comments', listPublicComments);
// POST /:token/comments — post a public comment; public (sessionToken-gated).
router.post('/:token/comments', postPublicComment);
// POST /:token/feedback — submit public course feedback; public (sessionToken-gated).
router.post('/:token/feedback', postPublicFeedback);

module.exports = router;
