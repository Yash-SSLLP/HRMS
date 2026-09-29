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
  dayAgenda,
  sendWish,
  receivedWishes, dismissWish, thankWish,
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
// GET /day?date=YYYY-MM-DD — one day of that calendar plus who is on leave,
// leaving and joining (the last two for CEO/MD/God or exit/employee managers);
// protected. 400 on an unreadable date. (2026-09-29)
router.get('/day', dayAgenda);
// GET /wishes/received — wishes received by the current user; protected.
router.get('/wishes/received', receivedWishes);
// PATCH /wishes/:id/dismiss — clear one wish off the dashboard card; protected.
router.patch('/wishes/:id/dismiss', dismissWish);
// POST /wishes/:id/thanks — thank whoever sent that wish; protected (recipient only).
router.post('/wishes/:id/thanks', thankWish);
// POST /wish — send a wish to a colleague; protected.
router.post('/wish', sendWish);

module.exports = router;
