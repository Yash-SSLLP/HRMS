/**
 * Audit router — mounted at /api/audit.
 * The portal-wide status-change audit log: read it back, and delete entries from
 * it permanently. SuperAdmin only, reads and deletes alike.
 */
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  listAudit, countAudit, deleteAuditEntries, purgeAudit,
} = require('../controllers/auditController');

const router = express.Router();

// SuperAdmin ONLY — deliberately not restrictTo('SuperAdmin'), which lets CEO/MD
// through on safe methods (see EXEC_VIEWERS in authMiddleware). The audit trail
// records who changed what across the whole portal, so it stays with the one
// role that administers the system — and so does deleting from it.
router.use(protect, (req, res, next) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    return next(new Error('Not authorised to view the audit log'));
  }
  return next();
});

// GET / — list audit-log entries (latest 200, max 500).
router.get('/', listAudit);
// GET /count — how many entries the filters match; feeds the purge confirmation.
router.get('/count', countAudit);
// POST /delete — permanently delete the chosen entries ({ ids }).
router.post('/delete', deleteAuditEntries);
// POST /purge — permanently delete every entry matching the filters.
router.post('/purge', purgeAudit);

module.exports = router;
