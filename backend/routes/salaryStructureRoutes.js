/**
 * Salary-structure router — mounted at /api/salary-structures.
 * Admin-only CRUD + preview of salary structure templates.
 * All routes require auth + the 'payroll.manage' permission.
 */
const express = require('express');
const {
  listStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
  assignStructure,
} = require('../controllers/salaryStructureController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Admin-only module
router.use(protect);
router.use(requirePermission('payroll.manage'));

// GET / — list salary structures; POST / — create one; protected, requires 'payroll.manage'.
router.route('/').get(listStructures).post(createStructure);
// POST /:id/preview — preview a computed structure; protected, requires 'payroll.manage'.
router.post('/:id/preview', previewStructure);
// POST /:id/assign — assign this structure (+ optional CTC) to an employee; requires 'payroll.manage'.
router.post('/:id/assign', assignStructure);
// PUT /:id — update a structure; DELETE /:id — delete it; protected, requires 'payroll.manage'.
router.route('/:id').put(updateStructure).delete(deleteStructure);

module.exports = router;
