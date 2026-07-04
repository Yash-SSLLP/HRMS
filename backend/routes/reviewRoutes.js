const express = require('express');
const {
  myReviews,
  aboutMe,
  submitReview,
  listCycles,
  createCycle,
  updateCycle,
  deleteCycle,
  assignReview,
  cycleReviews,
} = require('../controllers/reviewController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/me/assigned', myReviews);
router.get('/me/about', aboutMe);
router.patch('/me/:id', submitReview);

// HR/Admin
router.use(requirePermission('performance.manage'));
router.route('/cycles').get(listCycles).post(createCycle);
router.route('/cycles/:id').put(updateCycle).delete(deleteCycle);
router.post('/cycles/:id/assign', assignReview);
router.get('/cycles/:id/reviews', cycleReviews);

module.exports = router;
