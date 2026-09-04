/**
 * Shift router — mounted at /api/shifts.
 * Shift definitions and roster assignments: employee roster view plus
 * HR/Admin shift and roster management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listShifts, createShift, updateShift, deleteShift,
  listRoster, assignRoster, deleteRoster, myRoster,
  listShiftEmployees, assignShift, unassignShift,
} = require('../controllers/shiftController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /roster/me — current user's shift roster; protected.
router.get('/roster/me', myRoster);

// HR/Admin — everything below requires the 'attendance.manage' permission.
router.use(requirePermission('attendance.manage'));

// Roster routes must come BEFORE '/:id' so they are not captured by it.
// GET /roster — list roster assignments; protected, requires 'attendance.manage'.
router.get('/roster', listRoster);
// POST /roster — assign shifts in the roster; protected, requires 'attendance.manage'.
router.post('/roster', assignRoster);
// DELETE /roster/:id — remove a roster assignment; protected, requires 'attendance.manage'.
router.delete('/roster/:id', deleteRoster);

// GET / — list shifts; POST / — create a shift; protected, requires 'attendance.manage'.
router.route('/').get(listShifts).post(createShift);

// Standing assignment: who works this shift until it is changed. Declared
// BEFORE '/:id' for the same reason the roster routes are — '/:id' would
// otherwise swallow '/:id/employees' and answer it with a shift definition.
// GET /:id/employees — employees standing-assigned to this shift.
router.get('/:id/employees', listShiftEmployees);
// POST /:id/assign — put employees on this shift; POST /:id/unassign — take them off.
router.post('/:id/assign', assignShift);
router.post('/:id/unassign', unassignShift);
// PUT /:id — update a shift; DELETE /:id — delete it; protected, requires 'attendance.manage'.
router.route('/:id').put(updateShift).delete(deleteShift);

module.exports = router;
