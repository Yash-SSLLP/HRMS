const express = require('express');
const { overview } = require('../controllers/analyticsController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// Admin-only HR analytics. All routes require an authenticated admin.
router.use(protect);
router.use(restrictTo('SuperAdmin', 'HRManager'));

router.get('/overview', overview);

module.exports = router;
