/**
 * Push reminder router — mounted at /api/push-reminders.
 * SuperAdmin-authored recurring push notifications. Every route is SuperAdmin
 * only: these push at the whole company (or a whole department), which sits
 * above any capability an HR Manager holds.
 */
const express = require('express');
const {
  listReminders, createReminder, updateReminder, deleteReminder,
} = require('../controllers/pushReminderController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.use(restrictTo('SuperAdmin'));

// GET / — list custom reminders (+ the departments available to target).
// POST / — create one; protected, SuperAdmin only.
router.route('/')
  .get(listReminders)
  .post(createReminder);

// PUT /:id — update; DELETE /:id — remove; protected, SuperAdmin only.
router.route('/:id')
  .put(updateReminder)
  .delete(deleteReminder);

module.exports = router;
