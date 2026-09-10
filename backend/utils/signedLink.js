/**
 * Unguessable, no-login links to one specific record.
 *
 * The problem this solves: a PDF is read outside the app. A statement carries
 * bill thumbnails, and a thumbnail is too small to check a figure against — so
 * it has to be clickable. But a PDF viewer opens a link in a plain browser tab
 * with no Authorization header, and `?access_token=` would put the reader's own
 * session token into the document, the browser history and every forward of it.
 *
 * So the link carries an HMAC of the record id instead. It grants exactly one
 * thing — read this one attachment — to whoever holds the document, which is
 * the same audience that already has the bill embedded on the page above it.
 *
 * WHY NOT A STORED TOKEN, which is what payslips and offer letters use? Those
 * mint one token for one record when a human presses Send. A statement links
 * every row it prints — sixty of them under the report cap — and minting sixty
 * tokens would mean sixty writes every time somebody downloads a PDF. An HMAC
 * is derived, not stored: the same row always yields the same link, no write
 * happens, and nothing has to be migrated onto existing rows.
 *
 * SCOPE IS PART OF THE SIGNATURE. A signature minted for a khata receipt cannot
 * be replayed against some other route that happens to take the same id, so a
 * future signed link elsewhere cannot be opened with one of these.
 *
 * REVOCATION is by rotating the secret, which invalidates every link at once.
 * There is no per-link revocation and no expiry: a statement is an archival
 * document, and a link that dies in a week makes the document worse every day
 * it ages. Set RECEIPT_LINK_SECRET to rotate these without invalidating logins.
 */
const crypto = require('crypto');

/**
 * The signing key. Falls back to JWT_SECRET so no new environment variable is
 * required to deploy this; set RECEIPT_LINK_SECRET when you want the two to be
 * rotatable apart.
 * @returns {string}
 */
function secret() {
  return process.env.RECEIPT_LINK_SECRET || process.env.JWT_SECRET || '';
}

/**
 * Sign a record id for one purpose.
 * @param {string} scope - What the link is for, e.g. 'khata-receipt'.
 * @param {string} id - The record id.
 * @returns {string} 27-character base64url digest, safe in a path segment.
 */
function signId(scope, id) {
  return crypto.createHmac('sha256', secret())
    .update(`${scope}:${id}`)
    .digest('base64url')
    // 160 bits of the digest. Shorter than the full hash so the link stays
    // quotable, and far past anything guessable.
    .slice(0, 27);
}

/**
 * Check a signature against a record id.
 *
 * Compared with timingSafeEqual rather than `===`. The window is tiny here, but
 * a signature check written the obvious way is the one place a byte-by-byte
 * comparison leaks, and writing it correctly costs nothing.
 * @param {string} scope
 * @param {string} id
 * @param {string} sig - The signature from the URL.
 * @returns {boolean}
 */
function verifyId(scope, id, sig) {
  if (!secret() || !id || !sig) return false;
  const expected = Buffer.from(signId(scope, id));
  const given = Buffer.from(String(sig));
  // timingSafeEqual throws on a length mismatch, which is itself the answer.
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { signId, verifyId };
