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
// PUT /:id — update a structure; DELETE /:id — delete it; protected, requires 'payroll.manage'.
router.route('/:id').put(updateStructure).delete(deleteStructure);

module.exports = router;
