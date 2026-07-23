/**
 * Celebrations router — mounted at /api/celebrations.
 * Birthday/anniversary celebrations feed plus peer wishes.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  todayCelebrations,
  upcomingCelebrations,
  monthCalendar,
  sendWish,
  receivedWishes,
} = require('../controllers/celebrationsController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// All authenticated users may see the celebrations feed.
router.use(protect);

// GET /today — today's celebrations (birthdays/anniversaries); protected.
router.get('/today', todayCelebrations);
// GET /upcoming — upcoming celebrations; protected.
router.get('/upcoming', upcomingCelebrations);
// GET /calendar — month calendar of celebrations; protected.
router.get('/calendar', monthCalendar);
// GET /wishes/received — wishes received by the current user; protected.
router.get('/wishes/received', receivedWishes);
// POST /wish — send a wish to a colleague; protected.
router.post('/wish', sendWish);

module.exports = router;
