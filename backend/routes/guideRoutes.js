/**
 * Guide router — mounted at /api/guides.
 * Keyed in-app help/guide content: read by all, edited by HR/Admin.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { getGuide, saveGuide, resetGuide } = require('../controllers/guideController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Any authenticated user can read a guide.
// GET /:key — fetch a guide by key; protected.
router.get('/:key', getGuide);

// Only HR/Admin (announcements.manage) can edit or reset it.
// PUT /:key — save/update guide content; protected, requires 'announcements.manage'.
router.put('/:key', requirePermission('announcements.manage'), saveGuide);
// DELETE /:key — reset a guide to default; protected, requires 'announcements.manage'.
router.delete('/:key', requirePermission('announcements.manage'), resetGuide);

module.exports = router;
