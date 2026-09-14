/**
 * Mail identity router — mounted at /api/mail-identity.
 * A person connecting their own Google mailbox so HRMS mail they trigger is
 * sent from their address. The Google callback is public (the browser arrives
 * from Google, not from our SPA); everything else needs a signed-in account
 * whose role sends mail (services/mailIdentity SENDER_ROLES).
 */
const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  requireSender, getStatus, startConnect, finishConnect, disconnect, sendTest,
} = require('../controllers/mailIdentityController');

const router = express.Router();

// GET /google/callback — Google redirects here with ?code&state; identified by state only.
router.get('/google/callback', finishConnect);

router.use(protect);
router.use(requireSender);

// GET / — connection status + the redirect URI to register with Google.
router.get('/', getStatus);
// POST /google/start — consent URL to navigate to.
router.post('/google/start', startConnect);
// DELETE / — revoke + forget.
router.delete('/', disconnect);
// POST /test — send a test mail from the connected mailbox to itself.
router.post('/test', sendTest);

module.exports = router;
