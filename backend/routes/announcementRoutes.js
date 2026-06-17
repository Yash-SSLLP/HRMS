const express = require('express');
const {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} = require('../controllers/announcementController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// All authenticated users may read announcements.
router.use(protect);
router.get('/', listAnnouncements);

// Only HR/SuperAdmin may create/manage announcements.
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.post('/', createAnnouncement);
router.route('/:id').put(updateAnnouncement).delete(deleteAnnouncement);

module.exports = router;
