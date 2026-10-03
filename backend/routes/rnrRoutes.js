/**
 * R&R router — mounted at /api/rnr.
 * Rewards & recognition: employee award banner plus HR/Admin monthly
 * award management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  currentBanner,
  dismissBanner,
  listAwards,
  listPeople,
  upsertAward,
  announceAward,
  deleteAward,
  listCategories,
  createCategory,
  deleteCategory,
} = require('../controllers/rnrController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Any authenticated user: their own dashboard banner.
// GET /current — current award banner for the user; protected.
router.get('/current', currentBanner);
// POST /:id/dismiss — dismiss an award banner; protected.
router.post('/:id/dismiss', dismissBanner);

// HR/Admin only: manage the monthly awards (requires 'announcements.manage').
router.use(requirePermission('announcements.manage'));
// GET / — list awards; protected, requires 'announcements.manage'.
// Award categories (Best Employee first) — registered before the /:id routes.
router.get('/categories', listCategories);
router.post('/categories', createCategory);
router.delete('/categories/:id', deleteCategory);
router.get('/', listAwards);
// GET /people — list award-eligible people; protected, requires 'announcements.manage'.
router.get('/people', listPeople);
// POST / — create/update an award; protected, requires 'announcements.manage'.
router.post('/', upsertAward);
// POST /:id/announce — announce an award; protected, requires 'announcements.manage'.
router.post('/:id/announce', announceAward);
// DELETE /:id — delete an award; protected, requires 'announcements.manage'.
router.delete('/:id', deleteAward);

module.exports = router;
