/**
 * Password-reset router — mounted at /api/password-reset-requests.
 * Public lockout reset-request submission plus HR/Admin resolution
 * and password reset.
 */
const express = require('express');
const {
  createPasswordResetRequest,
  listPasswordResetRequests,
  resolvePasswordResetRequest,
  resetUserPassword,
} = require('../controllers/passwordResetRequestController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Public — submitted from the login page by a locked-out user (no auth).
// POST / — submit a password-reset request; public.
router.post('/', createPasswordResetRequest);

// HR / Admin only below this line (auth + 'users.manage').
router.use(protect, requirePermission('users.manage'));
// GET / — list reset requests; protected, requires 'users.manage'.
router.get('/', listPasswordResetRequests);
// PATCH /:id/resolve — mark a reset request resolved/dismissed; protected, requires 'users.manage'.
router.patch('/:id/resolve', resolvePasswordResetRequest);
// PATCH /:id/reset — reset the user's password; protected, requires 'users.manage'.
router.patch('/:id/reset', resetUserPassword);

module.exports = router;
