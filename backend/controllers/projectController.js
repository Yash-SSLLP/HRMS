const asyncHandler = require('express-async-handler');
const Project = require('../models/Project');
const { PROJECT_STATUS } = require('../models/Project');

const USER_FIELDS = 'firstName lastName email role';

const listProjects = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const projects = await Project.find(filter)
    .populate('manager', USER_FIELDS)
    .populate('members', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: projects.length, projects });
});

const createProject = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }
  if (req.body.status && !PROJECT_STATUS.includes(req.body.status)) {
    res.status(400);
    throw new Error(`status must be one of ${PROJECT_STATUS.join(', ')}`);
  }
  const project = await Project.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ project });
});

const updateProject = asyncHandler(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  delete req.body.createdBy;
  Object.assign(project, req.body);
  await project.save();
  res.json({ project });
});

const deleteProject = asyncHandler(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  await project.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listProjects, createProject, updateProject, deleteProject };
