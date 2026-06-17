const express = require('express');
const {
  listCourses,
  enroll,
  updateProgress,
  myLearning,
  listAdmin,
  createCourse,
  updateCourse,
  deleteCourse,
} = require('../controllers/courseController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee / shared
router.get('/', listCourses);
router.get('/me', myLearning);
router.post('/:id/enroll', enroll);
router.patch('/:id/progress', updateProgress);

// Admin-only
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.get('/admin/all', listAdmin);
router.post('/', createCourse);
router.put('/:id', updateCourse);
router.delete('/:id', deleteCourse);

module.exports = router;
