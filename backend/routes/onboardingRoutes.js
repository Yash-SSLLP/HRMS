const express = require('express');
const {
  listMyTasks, updateMyTaskStatus, listTasks, createTask, updateTask, deleteTask,
} = require('../controllers/onboardingController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/me', listMyTasks);
router.patch('/me/:id/status', updateMyTaskStatus);

// HR/Admin
router.use(requirePermission('onboarding.manage'));
router.route('/').get(listTasks).post(createTask);
router.route('/:id').put(updateTask).delete(deleteTask);

module.exports = router;
