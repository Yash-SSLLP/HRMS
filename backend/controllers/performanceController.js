const asyncHandler = require('express-async-handler');
const Goal = require('../models/Goal');
const { GOAL_STATUS } = require('../models/Goal');

const USER_FIELDS = 'firstName lastName email role';

// ===== HR/Admin =====
const listGoals = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.status) filter.status = req.query.status;
  const goals = await Goal.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: goals.length, goals });
});

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

const updateGoal = asyncHandler(async (req, res) => {
  const goal = await Goal.findById(req.params.id);
  if (!goal) {
    res.status(404);
    throw new Error('Goal not found');
  }
  delete req.body.createdBy;
  Object.assign(goal, req.body);
  await goal.save();
  res.json({ goal });
});

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
const listMyGoals = asyncHandler(async (req, res) => {
  const goals = await Goal.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: goals.length, goals });
});

// Employee may update progress on their own goal.
const updateMyGoalProgress = asyncHandler(async (req, res) => {
  const goal = await Goal.findById(req.params.id);
  if (!goal || !goal.employee.equals(req.user._id)) {
    res.status(404);
    throw new Error('Goal not found');
  }
  const { progress } = req.body;
  if (progress !== undefined) {
    goal.progress = Math.max(0, Math.min(100, Number(progress) || 0));
  }
  await goal.save();
  res.json({ goal });
});

module.exports = {
  listGoals, createGoal, updateGoal, deleteGoal, listMyGoals, updateMyGoalProgress,
};
