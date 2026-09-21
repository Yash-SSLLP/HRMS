/**
 * Org router — mounted at /api/org.
 * The reporting hierarchy / organization chart: readable by everyone, with one
 * write — the left-to-right arrangement of a branch, which a SuperAdmin sets.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { orgChart, setChartOrder } = require('../controllers/orgController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// Every authenticated user can view the reporting hierarchy.
// Setting a person's manager is done via PUT /api/employees/:id (SuperAdmin-only),
// which already validates the hierarchy.
router.use(protect);
// GET /chart — fetch the org/reporting hierarchy chart; protected (any authenticated user).
router.get('/chart', orgChart);

// PUT /chart/order — arrange one branch left to right (SuperAdmin).
// Cosmetic only: it moves cards beside each other, never reporting lines, which
// is why it is not behind hierarchy.manage like the manager edit is.
router.put('/chart/order', restrictTo('SuperAdmin'), setChartOrder);

module.exports = router;
