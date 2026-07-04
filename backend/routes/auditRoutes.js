const express = require('express');
const { protect, requirePermission } = require('../middleware/authMiddleware');
const { listAudit } = require('../controllers/auditController');

const router = express.Router();

// Audit trail is visible to SuperAdmin + HRs granted the audit capability.
router.use(protect, requirePermission('audit.view'));
router.get('/', listAudit);

module.exports = router;
