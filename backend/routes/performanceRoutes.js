/**
 * Performance router — mounted at /api/performance.
 * Performance-goal self-service plus HR/Admin goal management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listGoals, createGoal, updateGoal, deleteGoal, listMyGoals, updateMyGoalProgress,
} = require('../controllers/performanceController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /goals/me — current user's performance goals; protected.
router.get('/goals/me', listMyGoals);
// PATCH /goals/me/:id/progress — update progress on own goal; protected.
router.patch('/goals/me/:id/progress', updateMyGoalProgress);

// HR/Admin — everything below requires the 'performance.manage' permission.
router.use(requirePermission('performance.manage'));
// GET /goals — list goals; POST /goals — create one; protected, requires 'performance.manage'.
router.route('/goals').get(listGoals).post(createGoal);
// PUT /goals/:id — update a goal; DELETE /goals/:id — delete it; protected, requires 'performance.manage'.
router.route('/goals/:id').put(updateGoal).delete(deleteGoal);

module.exports = router;
