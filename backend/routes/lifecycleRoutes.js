/**
 * Lifecycle router — mounted at /api/lifecycle.
 * Employee lifecycle admin: probation confirmations + next employee code.
 * All routes require auth + the 'lifecycle.manage' permission.
 */
const express = require('express');
const {
  listConfirmations,
  updateConfirmation,
  nextEmployeeCode,
} = require('../controllers/lifecycleController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.use(requirePermission('lifecycle.manage'));

// GET /confirmations — list probation/confirmation records; protected, requires 'lifecycle.manage'.
router.get('/confirmations', listConfirmations);
// PATCH /confirmations/:id — update a confirmation decision; protected, requires 'lifecycle.manage'.
router.patch('/confirmations/:id', updateConfirmation);
// GET /next-code — next auto-generated employee code; protected, requires 'lifecycle.manage'.
router.get('/next-code', nextEmployeeCode);

module.exports = router;
