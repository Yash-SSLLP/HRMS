/**
 * Asset router — mounted at /api/assets.
 * Company asset inventory + assignments: employee view plus HR/Admin CRUD.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listAssets, createAsset, updateAsset, deleteAsset, assignAsset, listAssignments, listMyAssets,
} = require('../controllers/assetController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /me — assets assigned to the current user; protected.
router.get('/me', listMyAssets);

// HR/Admin — everything below requires the 'assets.manage' permission.
router.use(requirePermission('assets.manage'));
// GET /assignments — list all asset assignments; protected, requires 'assets.manage'.
router.get('/assignments', listAssignments);
// GET / — list assets; POST / — create one; protected, requires 'assets.manage'.
router.route('/').get(listAssets).post(createAsset);
// PATCH /:id/assign — assign/unassign an asset; protected, requires 'assets.manage'.
router.patch('/:id/assign', assignAsset);
// PUT/DELETE /:id — update/delete an asset; protected, requires 'assets.manage'.
router.route('/:id').put(updateAsset).delete(deleteAsset);

module.exports = router;
