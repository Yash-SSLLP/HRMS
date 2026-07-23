/**
 * Department router — mounted at /api/departments.
 * Department master list (readable by all) plus HR/SuperAdmin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require('../controllers/departmentController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read the department list (for dropdowns).
// GET / — list departments; protected (any authenticated user).
router.get('/', listDepartments);

// HR and SuperAdmin may create and rename departments; only SuperAdmin may delete.
// POST / — create a department; protected, requires 'org.manage'.
router.post('/', requirePermission('org.manage'), createDepartment);
// PUT /:id — rename/update a department; protected, requires 'org.manage'.
router.put('/:id', requirePermission('org.manage'), updateDepartment);
// DELETE /:id — delete a department; protected, SuperAdmin only.
router.delete('/:id', restrictTo('SuperAdmin'), deleteDepartment);

module.exports = router;
