const express = require('express');
const { overview } = require('../controllers/analyticsController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Admin-only HR analytics. All routes require an authenticated admin.
router.use(protect);
router.use(requirePermission('analytics.view'));

router.get('/overview', overview);

module.exports = router;
