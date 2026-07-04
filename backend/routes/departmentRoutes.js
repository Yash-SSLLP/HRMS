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
router.get('/', listDepartments);

// HR and SuperAdmin may create and rename departments; only SuperAdmin may delete.
router.post('/', requirePermission('org.manage'), createDepartment);
router.put('/:id', requirePermission('org.manage'), updateDepartment);
router.delete('/:id', restrictTo('SuperAdmin'), deleteDepartment);

module.exports = router;
