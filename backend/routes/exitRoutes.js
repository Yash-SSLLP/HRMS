/**
 * Exit router — mounted at /api/exits.
 * Resignation/exit workflow: public exit-feedback (token), employee
 * self-service resignation, and HR/Admin exit management.
 */
const express = require('express');
const {
  listExits,
  createExit,
  getExit,
  updateExit,
  cancelExit,
  completeExit,
  resendExitEmail,
  getMyExit,
  submitMyResignation,
  getFeedbackContext,
  submitFeedback,
} = require('../controllers/exitController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// -------- Public feedback (NO auth) --------
// Mounted first so they bypass the auth middleware below.
// GET /feedback/:token — load exit-feedback form context; public (token-scoped).
router.get('/feedback/:token', getFeedbackContext);
// POST /feedback/:token — submit exit feedback; public (token-scoped).
router.post('/feedback/:token', submitFeedback);

// -------- Authenticated --------
router.use(protect);

// Employee self-service
// GET /me — current user's own exit record; protected.
router.get('/me', getMyExit);
// POST /me — submit own resignation; protected.
router.post('/me', submitMyResignation);

// HR/Admin — everything below requires the 'exit.manage' permission.
router.use(requirePermission('exit.manage'));

// GET / — list exits; POST / — create an exit; protected, requires 'exit.manage'.
router.route('/')
  .get(listExits)
  .post(createExit);

// GET /:id — fetch one exit; PUT /:id — update it; protected, requires 'exit.manage'.
router.route('/:id')
  .get(getExit)
  .put(updateExit);

// PATCH /:id/cancel — cancel an exit; protected, requires 'exit.manage'.
router.patch('/:id/cancel', cancelExit);
// PATCH /:id/complete — mark an exit complete; protected, requires 'exit.manage'.
router.patch('/:id/complete', completeExit);
// POST /:id/resend-email — resend the exit email; protected, requires 'exit.manage'.
router.post('/:id/resend-email', resendExitEmail);

module.exports = router;
