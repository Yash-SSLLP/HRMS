// Signs the JWT used for API authentication. The payload's `tokenVersion` is
// checked by the auth middleware so a password change can invalidate old tokens.
const jwt = require('jsonwebtoken');

/**
 * Sign an auth JWT for a user.
 * @param {string} userId - User document id (embedded as `id`).
 * @param {string} role - User's role (embedded for quick client/route checks).
 * @param {number} [tokenVersion=0] - Session-invalidation counter; must match the user's current value at verify time.
 * @returns {string} A signed JWT expiring after JWT_EXPIRES_IN (default '1d').
 */
function generateToken(userId, role, tokenVersion = 0) {
  return jwt.sign({ id: userId, role, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

module.exports = generateToken;
