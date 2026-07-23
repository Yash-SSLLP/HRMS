/**
 * Notification router — mounted at /api/notifications.
 * In-app notification feed for the current user (list + mark read).
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listNotifications,
  markAllRead,
  markRead,
} = require('../controllers/notificationController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// All notification routes require a logged-in user.
router.use(protect);

// GET / — list current user's notifications; protected.
router.get('/', listNotifications);
// PATCH /read-all — mark all of the user's notifications read; protected.
router.patch('/read-all', markAllRead);
// PATCH /:id/read — mark a single notification read; protected.
router.patch('/:id/read', markRead);

module.exports = router;
