/**
 * Audit router — mounted at /api/audit.
 * Read-only portal-wide status-change audit log.
 * All routes require auth + the 'audit.view' permission.
 */
const express = require('express');
const { protect, requirePermission } = require('../middleware/authMiddleware');
const { listAudit } = require('../controllers/auditController');

const router = express.Router();

// Audit trail is visible to SuperAdmin + HRs granted the audit capability.
router.use(protect, requirePermission('audit.view'));
// GET / — list audit-log entries; protected, requires 'audit.view'.
router.get('/', listAudit);

module.exports = router;
