const express = require('express');
const {
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
} = require('../controllers/holidayController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read the holiday list.
router.get('/', listHolidays);

// Only HR/SuperAdmin may manage holidays.
router.post('/', restrictTo('SuperAdmin', 'HRManager'), createHoliday);
router.put('/:id', restrictTo('SuperAdmin', 'HRManager'), updateHoliday);
router.delete('/:id', restrictTo('SuperAdmin', 'HRManager'), deleteHoliday);

module.exports = router;
