/**
 * Project controller — CRUD for Project documents (name, status, manager,
 * members). Backs the HR/Admin project management screens; validates status
 * against the PROJECT_STATUS enum defined on the Project model.
 */
const asyncHandler = require('express-async-handler');
const Project = require('../models/Project');
const { PROJECT_STATUS } = require('../models/Project');

// Populated user sub-fields returned for manager/members references
const USER_FIELDS = 'firstName lastName email role';

/**
 * List projects, optionally filtered by status, newest first.
 * @route GET /api/projects
 * @param {string} [req.query.status] - filter by project status
 * @returns {{count: number, projects: Object[]}} projects with populated manager/members
 */
const listProjects = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const projects = await Project.find(filter)
    .populate('manager', USER_FIELDS)
    .populate('members', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: projects.length, projects });
});

/**
 * Create a project. Records the creating user as createdBy.
 * @route POST /api/projects
 * @param {string} req.body.name - required project name
 * @param {string} [req.body.status] - must be one of PROJECT_STATUS
 * @returns {{project: Object}} the created project (201)
 */
const createProject = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }
  // Reject unknown status values up-front
  if (req.body.status && !PROJECT_STATUS.includes(req.body.status)) {
    res.status(400);
    throw new Error(`status must be one of ${PROJECT_STATUS.join(', ')}`);
  }
  const project = await Project.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ project });
});

/**
 * Update a project by id (partial update via Object.assign).
 * @route PUT /api/projects/:id
 * @param {string} req.params.id - project id
 * @param {Object} req.body - fields to update
 * @returns {{project: Object}} the updated project
 */
const updateProject = asyncHandler(async (req, res) => {
  const project = await Project.findById(req.params.id);
  if (!project) {
    res.status(404);
    throw new Error('Project not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(project, req.body);
  await project.save();
  res.json({ project });
});

/**
 * Delete a project by id.
 * @route DELETE /api/projects/:id
 * @param {string} req.params.id - project id
 * @returns {{id: string, deleted: boolean}}
 */
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
