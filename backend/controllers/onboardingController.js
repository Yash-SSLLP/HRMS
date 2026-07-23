/**
 * Onboarding controller — per-employee onboarding checklist (OnboardingTask).
 * Employees see and tick off their own tasks; HR/Admin assign and manage tasks
 * across employees. Marking a task Done stamps completedAt.
 */
const asyncHandler = require('express-async-handler');
const OnboardingTask = require('../models/OnboardingTask');
const { ONBOARDING_STATUS } = require('../models/OnboardingTask');

const USER_FIELDS = 'firstName lastName email';
const CREATOR_FIELDS = 'firstName lastName';

// ===== Employee self-service =====
/**
 * List the caller's own onboarding tasks, oldest first.
 * @route GET /api/onboarding/me
 * @returns {{count: number, tasks: Object[]}}
 */
const listMyTasks = asyncHandler(async (req, res) => {
  const tasks = await OnboardingTask.find({ employee: req.user._id }).sort({ createdAt: 1 });
  res.json({ count: tasks.length, tasks });
});

/**
 * Employee updates the status of one of their own onboarding tasks.
 * @route PATCH /api/onboarding/me/:id/status
 * @param {string} req.params.id - task id (must belong to caller)
 * @param {string} req.body.status - one of ONBOARDING_STATUS
 * @returns {{task: Object}} completedAt set when status becomes 'Done'
 */
const updateMyTaskStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!ONBOARDING_STATUS.includes(status)) {
    res.status(400);
    throw new Error('Invalid status');
  }
  // Permission gate: 404 unless the task belongs to the caller
  const task = await OnboardingTask.findById(req.params.id);
  if (!task || String(task.employee) !== String(req.user._id)) {
    res.status(404);
    throw new Error('Task not found');
  }
  task.status = status;
  // Stamp completion time only when moving to Done, clear otherwise
  task.completedAt = status === 'Done' ? new Date() : undefined;
  await task.save();
  res.json({ task });
});

// ===== HR/Admin =====
/**
 * List onboarding tasks with optional employee/status filters.
 * @route GET /api/onboarding  (HR/Admin)
 * @param {string} [req.query.employee]
 * @param {string} [req.query.status]
 * @returns {{count: number, tasks: Object[]}} with populated employee/createdBy
 */
const listTasks = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.status) filter.status = req.query.status;
  const tasks = await OnboardingTask.find(filter)
    .populate('employee', USER_FIELDS)
    .populate('createdBy', CREATOR_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: tasks.length, tasks });
});

/**
 * Assign a new onboarding task to an employee.
 * @route POST /api/onboarding  (HR/Admin)
 * @param {string} req.body.employee - required
 * @param {string} req.body.title - required
 * @returns {{task: Object}} (201)
 */
const createTask = asyncHandler(async (req, res) => {
  const { employee, title } = req.body;
  if (!employee || !title) {
    res.status(400);
    throw new Error('employee and title are required');
  }
  const task = await OnboardingTask.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ task });
});

/**
 * Update an onboarding task (partial); stamps completedAt if left at Done.
 * @route PUT /api/onboarding/:id  (HR/Admin)
 * @param {string} req.params.id - task id
 * @param {Object} req.body - fields to update
 * @returns {{task: Object}}
 */
const updateTask = asyncHandler(async (req, res) => {
  const task = await OnboardingTask.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(task, req.body);
  // Backfill completion time if the task ended up Done without one
  if (task.status === 'Done' && !task.completedAt) task.completedAt = new Date();
  await task.save();
  res.json({ task });
});

/**
 * Delete an onboarding task by id.
 * @route DELETE /api/onboarding/:id  (HR/Admin)
 * @param {string} req.params.id - task id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteTask = asyncHandler(async (req, res) => {
  const task = await OnboardingTask.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  await task.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listMyTasks, updateMyTaskStatus, listTasks, createTask, updateTask, deleteTask,
};
