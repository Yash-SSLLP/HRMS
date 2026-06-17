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
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// -------- Public feedback (NO auth) --------
// Mounted first so they bypass the auth middleware below.
router.get('/feedback/:token', getFeedbackContext);
router.post('/feedback/:token', submitFeedback);

// -------- Authenticated --------
router.use(protect);

// Employee self-service
router.get('/me', getMyExit);
router.post('/me', submitMyResignation);

// HR/Admin
router.use(restrictTo('SuperAdmin', 'HRManager'));

router.route('/')
  .get(listExits)
  .post(createExit);

router.route('/:id')
  .get(getExit)
  .put(updateExit);

router.patch('/:id/cancel', cancelExit);
router.patch('/:id/complete', completeExit);
router.post('/:id/resend-email', resendExitEmail);

module.exports = router;
