/**
 * Org router — mounted at /api/org.
 * Read-only reporting hierarchy / organization chart.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { orgChart } = require('../controllers/orgController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Every authenticated user can view the reporting hierarchy.
// Setting a person's manager is done via PUT /api/employees/:id (SuperAdmin-only),
// which already validates the hierarchy.
router.use(protect);
// GET /chart — fetch the org/reporting hierarchy chart; protected (any authenticated user).
router.get('/chart', orgChart);

module.exports = router;
