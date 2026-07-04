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
router.post('/', createPasswordResetRequest);

// HR / Admin only below this line.
router.use(protect, requirePermission('users.manage'));
router.get('/', listPasswordResetRequests);
router.patch('/:id/resolve', resolvePasswordResetRequest);
router.patch('/:id/reset', resetUserPassword);

module.exports = router;
