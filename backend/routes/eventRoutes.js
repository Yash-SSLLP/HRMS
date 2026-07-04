const express = require('express');
const {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} = require('../controllers/eventController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read events.
router.get('/', listEvents);

// Only HR/SuperAdmin may create/manage events.
router.post('/', requirePermission('events.manage'), createEvent);
router.put('/:id', requirePermission('events.manage'), updateEvent);
router.delete('/:id', requirePermission('events.manage'), deleteEvent);

module.exports = router;
