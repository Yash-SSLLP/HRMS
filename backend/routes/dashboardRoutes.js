const express = require('express');
const { adminSummary } = require('../controllers/dashboardController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.get('/admin', restrictTo('SuperAdmin', 'HRManager'), adminSummary);

module.exports = router;
