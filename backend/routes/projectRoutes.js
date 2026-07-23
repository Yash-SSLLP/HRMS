/**
 * Project router — mounted at /api/projects.
 * Project master list (readable by all) plus HR/Admin CRUD.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listProjects,
  createProject,
  updateProject,
  deleteProject,
} = require('../controllers/projectController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// GET / — list projects; protected (any authenticated user).
router.get('/', listProjects);
// Everything below requires the 'projects.manage' permission.
router.use(requirePermission('projects.manage'));
// POST / — create a project; protected, requires 'projects.manage'.
router.post('/', createProject);
// PUT /:id — update a project; protected, requires 'projects.manage'.
router.put('/:id', updateProject);
// DELETE /:id — delete a project; protected, requires 'projects.manage'.
router.delete('/:id', deleteProject);

module.exports = router;
