const express = require('express');
const {
  listDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require('../controllers/departmentController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read the department list (for dropdowns).
router.get('/', listDepartments);

// HR and SuperAdmin may create and rename departments; only SuperAdmin may delete.
router.post('/', restrictTo('SuperAdmin', 'HRManager'), createDepartment);
router.put('/:id', restrictTo('SuperAdmin', 'HRManager'), updateDepartment);
router.delete('/:id', restrictTo('SuperAdmin'), deleteDepartment);

module.exports = router;
