const asyncHandler = require('express-async-handler');
const Task = require('../models/Task');
const { TASK_STATUS, TASK_PRIORITY } = require('../models/Task');

const USER_FIELDS = 'firstName lastName email role';

// ===== HR/Admin =====
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

const createTask = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const task = await Task.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ task });
});

const updateTask = asyncHandler(async (req, res) => {
  const task = await Task.findById(req.params.id);
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  delete req.body.createdBy;
  Object.assign(task, req.body);
  await task.save();
  res.json({ task });
});

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
const listMyTasks = asyncHandler(async (req, res) => {
  const tasks = await Task.find({ assignedTo: req.user._id })
    .populate('project', 'name status')
    .sort({ dueDate: 1, createdAt: -1 });
  res.json({ count: tasks.length, tasks });
});

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
