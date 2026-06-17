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

// Only SuperAdmin may manage departments.
router.post('/', restrictTo('SuperAdmin'), createDepartment);
router.put('/:id', restrictTo('SuperAdmin'), updateDepartment);
router.delete('/:id', restrictTo('SuperAdmin'), deleteDepartment);

module.exports = router;
