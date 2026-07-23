/**
 * Review router — mounted at /api/reviews.
 * Performance-review self-service plus HR/Admin review-cycle management.
 * All routes require authentication (router.use(protect)).
 */
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
// GET /me/assigned — reviews assigned to the current user to complete; protected.
router.get('/me/assigned', myReviews);
// GET /me/about — reviews written about the current user; protected.
router.get('/me/about', aboutMe);
// PATCH /me/:id — submit/save one of the user's assigned reviews; protected.
router.patch('/me/:id', submitReview);

// HR/Admin — everything below requires the 'performance.manage' permission.
router.use(requirePermission('performance.manage'));
// GET /cycles — list review cycles; POST /cycles — create one; protected, requires 'performance.manage'.
router.route('/cycles').get(listCycles).post(createCycle);
// PUT /cycles/:id — update a cycle; DELETE /cycles/:id — delete it; protected, requires 'performance.manage'.
router.route('/cycles/:id').put(updateCycle).delete(deleteCycle);
// POST /cycles/:id/assign — assign reviewers/reviewees to a cycle; protected, requires 'performance.manage'.
router.post('/cycles/:id/assign', assignReview);
// GET /cycles/:id/reviews — list all reviews in a cycle; protected, requires 'performance.manage'.
router.get('/cycles/:id/reviews', cycleReviews);

module.exports = router;
