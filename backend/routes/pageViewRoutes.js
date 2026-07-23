/**
 * Page-view router — mounted at /api/page-views.
 * Best-effort SPA navigation telemetry (console-logged, never persisted).
 * The single route is protected.
 */
const express = require('express');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Lightweight page-view logger. The SPA reports each in-app route change here so
// the server console shows human-readable navigation, e.g.  "Yash : My Shifts".
//
// For users who hold both portals (e.g. an HR Manager with an admin AND an
// employee profile), the client also sends which portal they're in, so the log
// reads "Yash as employee : ..." vs "Yash as admin : ...". Single-portal users
// send no portal and stay as plain "Yash : ...".
//
// Best-effort telemetry only — never persisted, never fails the client.
const PORTALS = { admin: 'admin', employee: 'employee' };

// POST / — log a client-side page/route change; protected.
router.post('/', protect, (req, res) => {
  const name = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'User';
  const page = String(req.body?.page || '').trim() || 'Unknown Page';
  const portal = PORTALS[req.body?.portal];
  const who = portal ? `${name} as ${portal}` : name;
  console.log(`${who} : ${page}`);
  res.sendStatus(204);
});

module.exports = router;
