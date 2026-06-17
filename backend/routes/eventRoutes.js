const express = require('express');
const {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} = require('../controllers/eventController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read events.
router.get('/', listEvents);

// Only HR/SuperAdmin may create/manage events.
router.post('/', restrictTo('SuperAdmin', 'HRManager'), createEvent);
router.put('/:id', restrictTo('SuperAdmin', 'HRManager'), updateEvent);
router.delete('/:id', restrictTo('SuperAdmin', 'HRManager'), deleteEvent);

module.exports = router;
