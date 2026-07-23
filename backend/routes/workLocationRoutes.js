/**
 * Work-location router — mounted at /api/work-locations.
 * Named work sites/geofences and employee-to-location assignments.
 * All routes require authentication (router.use(protect)).
 */
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
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Any authenticated user may read the list (used for dropdowns).
// GET / — list work locations; protected (any authenticated user).
router.get('/', listLocations);

// HR / SuperAdmin manage locations and assignments (requires 'org.manage').
router.use(requirePermission('org.manage'));
// GET /:id/employees — employees assigned to a location; protected, requires 'org.manage'.
router.get('/:id/employees', listAssigned);
// POST / — create a work location; protected, requires 'org.manage'.
router.post('/', createLocation);
// PUT /:id — update a work location; protected, requires 'org.manage'.
router.put('/:id', updateLocation);
// DELETE /:id — delete a work location; protected, requires 'org.manage'.
router.delete('/:id', deleteLocation);
// POST /:id/assign — assign employees to a location; protected, requires 'org.manage'.
router.post('/:id/assign', assignEmployees);
// POST /:id/unassign — remove employees from a location; protected, requires 'org.manage'.
router.post('/:id/unassign', unassignEmployees);

module.exports = router;
