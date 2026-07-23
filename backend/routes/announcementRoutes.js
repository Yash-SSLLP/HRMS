/**
 * Announcement router — mounted at /api/announcements.
 * Employee read/dismiss of announcements plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listAnnouncements,
  dismissAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} = require('../controllers/announcementController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// All authenticated users may read announcements and dismiss them from their
// own overview banner.
router.use(protect);
// GET / — list announcements; protected.
router.get('/', listAnnouncements);
// POST /:id/dismiss — dismiss an announcement from own banner; protected.
router.post('/:id/dismiss', dismissAnnouncement);

// Only HR/SuperAdmin may create/manage announcements (requires 'announcements.manage').
router.use(requirePermission('announcements.manage'));
// POST / — create an announcement; protected, requires 'announcements.manage'.
router.post('/', createAnnouncement);
// PUT/DELETE /:id — update/delete an announcement; protected, requires 'announcements.manage'.
router.route('/:id').put(updateAnnouncement).delete(deleteAnnouncement);

module.exports = router;
