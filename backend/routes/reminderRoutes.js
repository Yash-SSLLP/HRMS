/**
 * Reminders router — mounted at /api/reminders.
 * Calendar reminders: everyone manages their own; SuperAdmin/HRManager/CEO/MD can
 * also aim one at people, a department, or the whole company (enforced in the
 * controller, which is why there is no restrictTo gate here — CEO/MD are
 * deliberately allowed to write on this route).
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
} = require('../controllers/reminderController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// GET / — reminders visible to the caller (?month=YYYY-MM, ?mine=1).
router.get('/', listReminders);
// POST / — create a reminder (scope beyond 'self' needs a broadcast role).
router.post('/', createReminder);
// PUT /:id — update own reminder (SuperAdmin may update any).
router.put('/:id', updateReminder);
// DELETE /:id — delete own reminder (SuperAdmin may delete any).
router.delete('/:id', deleteReminder);

module.exports = router;
