/**
 * Task controller — CRUD for Task documents plus employee self-service.
 * HR/Admin manage all tasks (assign to users, link to projects); employees
 * list and advance the status of tasks assigned to them only.
 */
const asyncHandler = require('express-async-handler');
const Task = require('../models/Task');
const { TASK_STATUS, TASK_PRIORITY } = require('../models/Task');

// Populated user sub-fields returned for assignedTo references
const USER_FIELDS = 'firstName lastName email role';

// ===== HR/Admin =====
/**
 * List all tasks with optional filters, newest first.
 * @route GET /api/tasks
 * @param {string} [req.query.project] - filter by project id
 * @param {string} [req.query.assignedTo] - filter by assignee id
 * @param {string} [req.query.status] - filter by task status
 * @returns {{count: number, tasks: Object[]}} tasks with populated assignee/project
 */
const listTasks = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.project) filter.project = req.query.project;
  if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
  if (req.query.status) filter.status = req.query.status;
  const tasks = await Task.find(filter)
    .populate('assignedTo', USER_FIELDS)
    .populate('project', 'name status')
    .sort({ createdAt: -1 });
  res.json({ count: tasks.length, tasks });
});

/**
 * Create a task. Records the creating user as createdBy.
 * @route POST /api/tasks
 * @param {string} req.body.title - required task title
 * @param {Object} req.body - other task fields (project, assignedTo, status, priority, dueDate)
 * @returns {{task: Object}} the created task (201)
 */
const createTask = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const task = await Task.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ task });
});

/**
 * Update a task by id (partial update via Object.assign).
 * @route PUT /api/tasks/:id
 * @param {string} req.params.id - task id
 * @param {Object} req.body - fields to update
 * @returns {{task: Object}} the updated task
 */
const updateTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(task, req.body);
  await task.save();
  res.json({ task });
});

/**
 * Delete a task by id.
 * @route DELETE /api/tasks/:id
 * @param {string} req.params.id - task id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  await task.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Employee self-service =====
/**
 * List tasks assigned to the current user, ordered by due date.
 * @route GET /api/tasks/me
 * @returns {{count: number, tasks: Object[]}} the user's tasks with populated project
 */
const listMyTasks = asyncHandler(async (req, res) => {
  const tasks = await Task.find({ assignedTo: req.user._id })
    .populate('project', 'name status')
    .sort({ dueDate: 1, createdAt: -1 });
  res.json({ count: tasks.length, tasks });
});

/**
 * Assignee moves their own task's status (self-service, cannot edit others').
 * @route PATCH /api/tasks/me/:id/status
 * @param {string} req.params.id - task id
 * @param {string} req.body.status - new status, must be one of TASK_STATUS
 * @returns {{task: Object}} the updated task
 */
// PATCH /api/tasks/me/:id/status  — assignee may move their own task's status
const updateMyTaskStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!TASK_STATUS.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${TASK_STATUS.join(', ')}`);
  }
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  // Permission gate: only the assignee may change the status
  if (!task.assignedTo || !task.assignedTo.equals(req.user._id)) {
    res.status(403);
    throw new Error('You can only update tasks assigned to you');
  }
  task.status = status;
  await task.save();
  res.json({ task });
});

module.exports = {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  listMyTasks,
  updateMyTaskStatus,
  TASK_STATUS,
  TASK_PRIORITY,
};
