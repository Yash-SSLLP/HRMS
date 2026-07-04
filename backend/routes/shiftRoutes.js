const express = require('express');
const {
  listShifts, createShift, updateShift, deleteShift,
  listRoster, assignRoster, deleteRoster, myRoster,
} = require('../controllers/shiftController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/roster/me', myRoster);

// HR/Admin
router.use(requirePermission('attendance.manage'));

// Roster routes must come BEFORE '/:id' so they are not captured by it.
router.get('/roster', listRoster);
router.post('/roster', assignRoster);
router.delete('/roster/:id', deleteRoster);

router.route('/').get(listShifts).post(createShift);
router.route('/:id').put(updateShift).delete(deleteShift);

module.exports = router;
