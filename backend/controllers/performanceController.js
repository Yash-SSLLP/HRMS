/**
 * Performance controller — manages employee performance Goals. HR/Admin do full
 * CRUD and assign goals to employees; employees list their own goals and update
 * their progress percentage.
 */
const asyncHandler = require('express-async-handler');
const Goal = require('../models/Goal');
const { GOAL_STATUS } = require('../models/Goal');

const USER_FIELDS = 'firstName lastName email role';

// ===== HR/Admin =====
/**
 * List goals with optional employee/status filters, newest first.
 * @route GET /api/goals  (HR/Admin)
 * @param {string} [req.query.employee] - filter by employee id
 * @param {string} [req.query.status]
 * @returns {{count: number, goals: Object[]}} with populated employee
 */
const listGoals = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.status) filter.status = req.query.status;
  const goals = await Goal.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: goals.length, goals });
});

/**
 * Create a goal for an employee.
 * @route POST /api/goals  (HR/Admin)
 * @param {string} req.body.employee - required
 * @param {string} req.body.title - required
 * @param {string} [req.body.status] - must be one of GOAL_STATUS
 * @returns {{goal: Object}} (201)
 */
const createGoal = asyncHandler(async (req, res) => {
  const { employee, title } = req.body;
  if (!employee || !title) {
    res.status(400);
    throw new Error('employee and title are required');
  }
  if (req.body.status && !GOAL_STATUS.includes(req.body.status)) {
    res.status(400);
    throw new Error(`status must be one of ${GOAL_STATUS.join(', ')}`);
  }
  const goal = await Goal.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ goal });
});

/**
 * Update a goal (partial).
 * @route PUT /api/goals/:id  (HR/Admin)
 * @param {string} req.params.id - goal id
 * @param {Object} req.body - fields to update
 * @returns {{goal: Object}}
 */
const updateGoal = asyncHandler(async (req, res) => {
  const goal = await Goal.findById(req.params.id);
  if (!goal) {
    res.status(404);
    throw new Error('Goal not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(goal, req.body);
  await goal.save();
  res.json({ goal });
});

/**
 * Delete a goal by id.
 * @route DELETE /api/goals/:id  (HR/Admin)
 * @param {string} req.params.id - goal id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteGoal = asyncHandler(async (req, res) => {
  const goal = await Goal.findById(req.params.id);
  if (!goal) {
    res.status(404);
    throw new Error('Goal not found');
  }
  await goal.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Employee self-service =====
/**
 * List the caller's own goals, newest first.
 * @route GET /api/goals/me
 * @returns {{count: number, goals: Object[]}}
 */
const listMyGoals = asyncHandler(async (req, res) => {
  const goals = await Goal.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: goals.length, goals });
});

/**
 * Employee updates the progress on one of their own goals.
 * @route PATCH /api/goals/me/:id/progress
 * @param {string} req.params.id - goal id (must belong to caller)
 * @param {number} req.body.progress - clamped to 0-100
 * @returns {{goal: Object}}
 */
// Employee may update progress on their own goal.
const updateMyGoalProgress = asyncHandler(async (req, res) => {
  // Permission gate: 404 unless the goal belongs to the caller
  const goal = await Goal.findById(req.params.id);
  if (!goal || !goal.employee.equals(req.user._id)) {
    res.status(404);
    throw new Error('Goal not found');
  }
  const { progress } = req.body;
  if (progress !== undefined) {
    // Clamp progress into the valid 0-100 range
    goal.progress = Math.max(0, Math.min(100, Number(progress) || 0));
  }
  await goal.save();
  res.json({ goal });
});

module.exports = {
  listGoals, createGoal, updateGoal, deleteGoal, listMyGoals, updateMyGoalProgress,
};
