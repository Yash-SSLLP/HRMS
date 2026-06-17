const express = require('express');
const { orgChart } = require('../controllers/orgController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Every authenticated user can view the reporting hierarchy.
// Setting a person's manager is done via PUT /api/employees/:id (SuperAdmin-only),
// which already validates the hierarchy.
router.use(protect);
router.get('/chart', orgChart);

module.exports = router;
