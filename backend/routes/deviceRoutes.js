/**
 * Device router — mounted at /api/devices.
 * Registers/unregisters mobile push notification device tokens.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { registerDevice, unregisterDevice } = require('../controllers/deviceController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// All device routes require a logged-in user.
router.use(protect);

// POST /register — register a push device token for the current user; protected.
router.post('/register', registerDevice);
// DELETE /:token — unregister a push device token; protected.
router.delete('/:token', unregisterDevice);

module.exports = router;
