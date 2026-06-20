const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { listAudit } = require('../controllers/auditController');

const router = express.Router();

// Audit trail is visible to HR and SuperAdmin only.
router.use(protect, restrictTo('SuperAdmin', 'HRManager'));
router.get('/', listAudit);

module.exports = router;
