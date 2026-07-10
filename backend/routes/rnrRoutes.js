const express = require('express');
const {
  currentBanner,
  dismissBanner,
  listAwards,
  listPeople,
  upsertAward,
  announceAward,
  deleteAward,
} = require('../controllers/rnrController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Any authenticated user: their own dashboard banner.
router.get('/current', currentBanner);
router.post('/:id/dismiss', dismissBanner);

// HR/Admin only: manage the monthly awards.
router.use(requirePermission('announcements.manage'));
router.get('/', listAwards);
router.get('/people', listPeople);
router.post('/', upsertAward);
router.post('/:id/announce', announceAward);
router.delete('/:id', deleteAward);

module.exports = router;
