const asyncHandler = require('express-async-handler');
const OnboardingTask = require('../models/OnboardingTask');
const { ONBOARDING_STATUS } = require('../models/OnboardingTask');

const USER_FIELDS = 'firstName lastName email';
const CREATOR_FIELDS = 'firstName lastName';

// ===== Employee self-service =====
const listMyTasks = asyncHandler(async (req, res) => {
  const tasks = await OnboardingTask.find({ employee: req.user._id }).sort({ createdAt: 1 });
  res.json({ count: tasks.length, tasks });
});

const updateMyTaskStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!ONBOARDING_STATUS.includes(status)) {
    res.status(400);
    throw new Error('Invalid status');
  }
  const task = await OnboardingTask.findById(req.params.id);
  if (!task || String(task.employee) !== String(req.user._id)) {
    res.status(404);
    throw new Error('Task not found');
  }
  task.status = status;
  task.completedAt = status === 'Done' ? new Date() : undefined;
  await task.save();
  res.json({ task });
});

// ===== HR/Admin =====
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

const createTask = asyncHandler(async (req, res) => {
  const { employee, title } = req.body;
  if (!employee || !title) {
    res.status(400);
    throw new Error('employee and title are required');
  }
  const task = await OnboardingTask.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ task });
});

const updateTask = asyncHandler(async (req, res) => {
  const task = await OnboardingTask.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  delete req.body.createdBy;
  Object.assign(task, req.body);
  if (task.status === 'Done' && !task.completedAt) task.completedAt = new Date();
  await task.save();
  res.json({ task });
});

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
