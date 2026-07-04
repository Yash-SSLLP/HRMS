const express = require('express');
const {
  listAssets, createAsset, updateAsset, deleteAsset, assignAsset, listMyAssets,
} = require('../controllers/assetController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/me', listMyAssets);

// HR/Admin
router.use(requirePermission('assets.manage'));
router.route('/').get(listAssets).post(createAsset);
router.patch('/:id/assign', assignAsset);
router.route('/:id').put(updateAsset).delete(deleteAsset);

module.exports = router;
