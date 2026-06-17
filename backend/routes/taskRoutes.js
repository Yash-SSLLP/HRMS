const express = require('express');
const {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listMyTasks,
  updateMyTaskStatus,
} = require('../controllers/taskController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/me', listMyTasks);
router.patch('/me/:id/status', updateMyTaskStatus);

// HR/Admin
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.route('/').get(listTasks).post(createTask);
router.route('/:id').put(updateTask).delete(deleteTask);

module.exports = router;
