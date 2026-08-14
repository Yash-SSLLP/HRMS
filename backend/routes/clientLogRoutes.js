/**
 * Client log sink — mounted at /api/client-logs.
 *
 * The mobile app's console output goes to the device's logcat, which nobody can
 * read without a USB cable, so a failure on a user's phone is invisible: the
 * screens swallow errors (`.catch(() => ({ data: {} }))`) and render as "no
 * data". This forwards those lines into the SAME server log the backend's own
 * console.* output lands in, so one place explains both halves of a problem.
 *
 * Auth is OPTIONAL by design. A login failure is exactly the kind of thing worth
 * seeing, and at that moment there is no token — so a request without one is
 * accepted and simply logged as `anon`. The identity is never trusted from the
 * body; it comes from the token or not at all.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

// Caps. A looping client must not be able to fill the log or the request body.
const MAX_ENTRIES = 50;      // per request
const MAX_MESSAGE_CHARS = 2000;
const LEVELS = new Set(['log', 'info', 'warn', 'error']);

// Per-IP throttle: a simple in-memory token bucket. Deliberately not a shared
// store — this is a diagnostic sink, and a per-instance cap is enough to stop a
// runaway client without adding infrastructure.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;
const buckets = new Map();

function throttled(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > WINDOW_MS) {
    buckets.set(ip, { start: now, count: 1 });
    // Opportunistic cleanup so the map cannot grow without bound.
    if (buckets.size > 500) {
      for (const [k, v] of buckets) if (now - v.start > WINDOW_MS) buckets.delete(k);
    }
    return false;
  }
  b.count += 1;
  return b.count > MAX_REQUESTS_PER_WINDOW;
}

// Resolve the caller if they sent a valid token; never fail the request if not.
async function whoIs(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return 'anon';
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('firstName lastName email role');
    if (!user) return 'anon';
    const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
    return `${name} (${user.role})`;
  } catch {
    return 'anon';
  }
}

/**
 * Accept a batch of client log lines and re-emit them into the server log.
 * @route POST /api/client-logs
 * @param {Object[]} req.body.entries - [{ level, message, at }]
 * @param {string} [req.body.platform] - e.g. 'android'
 * @param {string} [req.body.appVersion]
 * @returns {{received: number}} 202; 429 when throttled
 */
router.post('/', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (throttled(ip)) return res.status(429).json({ message: 'Too many log batches' });

  const { entries, platform, appVersion } = req.body || {};
  if (!Array.isArray(entries) || !entries.length) return res.status(202).json({ received: 0 });

  let who = 'anon';
  try { who = await whoIs(req); } catch { /* logging must never break on identity */ }

  const tag = `[mobile${platform ? `/${platform}` : ''}${appVersion ? ` v${appVersion}` : ''}]`;
  const batch = entries.slice(0, MAX_ENTRIES);

  for (const e of batch) {
    const level = LEVELS.has(e?.level) ? e.level : 'log';
    const message = String(e?.message ?? '').slice(0, MAX_MESSAGE_CHARS);
    if (!message) continue;
    // `at` is the moment it happened ON THE DEVICE, which can be well before it
    // was delivered (offline, backgrounded), so it is printed rather than
    // implied by the server's own log timestamp.
    const when = e?.at ? new Date(e.at).toISOString() : new Date().toISOString();
    const line = `${tag} ${who} ${when} — ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  res.status(202).json({ received: batch.length });
});

module.exports = router;
