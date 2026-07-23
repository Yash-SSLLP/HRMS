/**
 * Event router — mounted at /api/events.
 * Company events calendar (readable by all) plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
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
// GET / — list events; protected (any authenticated user).
router.get('/', listEvents);

// Only HR/SuperAdmin may create/manage events.
// POST / — create an event; protected, requires 'events.manage'.
router.post('/', requirePermission('events.manage'), createEvent);
// PUT /:id — update an event; protected, requires 'events.manage'.
router.put('/:id', requirePermission('events.manage'), updateEvent);
// DELETE /:id — delete an event; protected, requires 'events.manage'.
router.delete('/:id', requirePermission('events.manage'), deleteEvent);

module.exports = router;
