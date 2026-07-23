/**
 * Holiday router — mounted at /api/holidays.
 * Holiday calendar (readable by all) plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
} = require('../controllers/holidayController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read the holiday list.
// GET / — list holidays; protected (any authenticated user).
router.get('/', listHolidays);

// Only HR/SuperAdmin may manage holidays (guarded by 'leave.manage').
// POST / — create a holiday; protected, requires 'leave.manage'.
router.post('/', requirePermission('leave.manage'), createHoliday);
// PUT /:id — update a holiday; protected, requires 'leave.manage'.
router.put('/:id', requirePermission('leave.manage'), updateHoliday);
// DELETE /:id — delete a holiday; protected, requires 'leave.manage'.
router.delete('/:id', requirePermission('leave.manage'), deleteHoliday);

module.exports = router;
