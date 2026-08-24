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
  assignClearanceApprovers,
  updateClearanceSectionAdmin,
  overrideClearance,
  relievingLetterPdf,
  myRelievingLetterPdf,
  publicRelievingLetterPdf,
} = require('../controllers/exitController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// -------- Public feedback (NO auth) --------
// Mounted first so they bypass the auth middleware below.
// GET /feedback/:token — load exit-feedback form context; public (token-scoped).
router.get('/feedback/:token', getFeedbackContext);
// GET /feedback/:token/relieving-letter.pdf — the leaver's relieving letter, no
// login required. Completing an exit switches their account off, so this token
// link is the only way the letter actually reaches the person it is about.
router.get('/feedback/:token/relieving-letter.pdf', publicRelievingLetterPdf);
// POST /feedback/:token — submit exit feedback; public (token-scoped).
router.post('/feedback/:token', submitFeedback);

// -------- Authenticated --------
router.use(protect);

// Employee self-service
// GET /me — current user's own exit record; protected.
router.get('/me', getMyExit);
// GET /me/relieving-letter.pdf — my own relieving letter, while my login works.
router.get('/me/relieving-letter.pdf', myRelievingLetterPdf);
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

// -------- No-dues clearance (HR/Admin) --------
// PATCH /:id/clearance-assignees — assign a manager to each no-dues section.
router.patch('/:id/clearance-assignees', assignClearanceApprovers);
// PATCH /:id/clearance/override — HR override of the no-dues gate (with reason).
router.patch('/:id/clearance/override', overrideClearance);

// GET /:id/relieving-letter.pdf — the leaver's relieving letter as a PDF;
// requires 'exit.manage'. Refused until no-dues clearance is satisfied and the
// last working day has passed — the letter certifies both.
router.get('/:id/relieving-letter.pdf', relievingLetterPdf);
// PATCH /:id/clearance/:key — HR ticks a no-dues section.
router.patch('/:id/clearance/:key', updateClearanceSectionAdmin);

module.exports = router;
