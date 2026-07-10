const express = require('express');
const { getGuide, saveGuide, resetGuide } = require('../controllers/guideController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Any authenticated user can read a guide.
router.get('/:key', getGuide);

// Only HR/Admin (announcements.manage) can edit or reset it.
router.put('/:key', requirePermission('announcements.manage'), saveGuide);
router.delete('/:key', requirePermission('announcements.manage'), resetGuide);

module.exports = router;
