const express = require('express');
const {
  todayCelebrations,
  upcomingCelebrations,
  monthCalendar,
  sendWish,
} = require('../controllers/celebrationsController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// All authenticated users may see the celebrations feed.
router.use(protect);

router.get('/today', todayCelebrations);
router.get('/upcoming', upcomingCelebrations);
router.get('/calendar', monthCalendar);
router.post('/wish', sendWish);

module.exports = router;
