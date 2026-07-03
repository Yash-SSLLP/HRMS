const express = require('express');
const {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  listAssigned,
  assignEmployees,
  unassignEmployees,
} = require('../controllers/workLocationController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Any authenticated user may read the list (used for dropdowns).
router.get('/', listLocations);

// HR / SuperAdmin manage locations and assignments.
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.get('/:id/employees', listAssigned);
router.post('/', createLocation);
router.put('/:id', updateLocation);
router.delete('/:id', deleteLocation);
router.post('/:id/assign', assignEmployees);
router.post('/:id/unassign', unassignEmployees);

module.exports = router;
