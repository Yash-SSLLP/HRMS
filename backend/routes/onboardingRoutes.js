/**
 * Onboarding router — mounted at /api/onboarding.
 * Onboarding-task self-service plus HR/Admin task management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listMyTasks, updateMyTaskStatus, listTasks, createTask, updateTask, deleteTask,
} = require('../controllers/onboardingController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /me — current user's onboarding tasks; protected.
router.get('/me', listMyTasks);
// PATCH /me/:id/status — update status of own onboarding task; protected.
router.patch('/me/:id/status', updateMyTaskStatus);

// HR/Admin — everything below requires the 'onboarding.manage' permission.
router.use(requirePermission('onboarding.manage'));
// GET / — list onboarding tasks; POST / — create one; protected, requires 'onboarding.manage'.
router.route('/').get(listTasks).post(createTask);
// PUT /:id — update a task; DELETE /:id — delete it; protected, requires 'onboarding.manage'.
router.route('/:id').put(updateTask).delete(deleteTask);

module.exports = router;
