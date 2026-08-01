/**
 * Audit router — mounted at /api/audit.
 * Read-only portal-wide status-change audit log. SuperAdmin only.
 */
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { listAudit } = require('../controllers/auditController');

const router = express.Router();

// SuperAdmin ONLY — deliberately not restrictTo('SuperAdmin'), which lets CEO/MD
// through on safe methods (see EXEC_VIEWERS in authMiddleware). The audit trail
// records who changed what across the whole portal, so it stays with the one
// role that administers the system.
router.use(protect, (req, res, next) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    return next(new Error('Not authorised to view the audit log'));
  }
  return next();
});

// GET / — list audit-log entries; protected, SuperAdmin only.
router.get('/', listAudit);

module.exports = router;
