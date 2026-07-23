/**
 * Task router — mounted at /api/tasks.
 * General task-assignment self-service plus HR/Admin task management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listMyTasks,
  updateMyTaskStatus,
} = require('../controllers/taskController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /me — current user's assigned tasks; protected.
router.get('/me', listMyTasks);
// PATCH /me/:id/status — update status of own task; protected.
router.patch('/me/:id/status', updateMyTaskStatus);

// HR/Admin — everything below requires the 'tasks.manage' permission.
router.use(requirePermission('tasks.manage'));
// GET / — list tasks; POST / — create one; protected, requires 'tasks.manage'.
router.route('/').get(listTasks).post(createTask);
// PUT /:id — update a task; DELETE /:id — delete it; protected, requires 'tasks.manage'.
router.route('/:id').put(updateTask).delete(deleteTask);

module.exports = router;
