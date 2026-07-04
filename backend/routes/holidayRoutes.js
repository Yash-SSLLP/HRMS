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
router.get('/', listHolidays);

// Only HR/SuperAdmin may manage holidays.
router.post('/', requirePermission('leave.manage'), createHoliday);
router.put('/:id', requirePermission('leave.manage'), updateHoliday);
router.delete('/:id', requirePermission('leave.manage'), deleteHoliday);

module.exports = router;
