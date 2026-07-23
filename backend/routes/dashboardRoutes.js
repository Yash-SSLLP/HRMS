/**
 * Dashboard router — mounted at /api/dashboard.
 * Aggregated admin dashboard summary metrics.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { adminSummary } = require('../controllers/dashboardController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// All dashboard routes require a logged-in user.
router.use(protect);

// GET /admin — admin dashboard summary; protected, SuperAdmin/HRManager only.
router.get('/admin', restrictTo('SuperAdmin', 'HRManager'), adminSummary);

module.exports = router;
