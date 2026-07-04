const express = require('express');
const {
  listGoals, createGoal, updateGoal, deleteGoal, listMyGoals, updateMyGoalProgress,
} = require('../controllers/performanceController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/goals/me', listMyGoals);
router.patch('/goals/me/:id/progress', updateMyGoalProgress);

// HR/Admin
router.use(requirePermission('performance.manage'));
router.route('/goals').get(listGoals).post(createGoal);
router.route('/goals/:id').put(updateGoal).delete(deleteGoal);

module.exports = router;
