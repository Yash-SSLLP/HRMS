/**
 * Compliance router — mounted at /api/compliance.
 * Statutory payroll compliance reports (PF, ESI, PT, TDS, Form 16).
 * All routes require auth + the 'compliance.view' permission.
 */
const express = require('express');
const {
  pfReport,
  esiReport,
  ptReport,
  tdsReport,
  form16Summary,
} = require('../controllers/complianceController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Statutory compliance reports are admin-only.
router.use(protect);
router.use(requirePermission('compliance.view'));

// GET /pf — Provident Fund report; protected, requires 'compliance.view'.
router.get('/pf', pfReport);
// GET /esi — ESI report; protected, requires 'compliance.view'.
router.get('/esi', esiReport);
// GET /pt — Professional Tax report; protected, requires 'compliance.view'.
router.get('/pt', ptReport);
// GET /tds — TDS report; protected, requires 'compliance.view'.
router.get('/tds', tdsReport);
// GET /form16 — Form 16 summary; protected, requires 'compliance.view'.
router.get('/form16', form16Summary);

module.exports = router;
