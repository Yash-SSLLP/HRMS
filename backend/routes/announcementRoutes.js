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
router.get('/', listAnnouncements);
router.post('/:id/dismiss', dismissAnnouncement);

// Only HR/SuperAdmin may create/manage announcements.
router.use(requirePermission('announcements.manage'));
router.post('/', createAnnouncement);
router.route('/:id').put(updateAnnouncement).delete(deleteAnnouncement);

module.exports = router;
