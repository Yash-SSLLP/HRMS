/**
 * Small authenticated-encryption box for secrets that have to live in the
 * database but must never be readable from a dump — today, each person's Google
 * refresh token (User.mailIdentity.refreshToken).
 *
 * AES-256-GCM with a random IV per value. The key is derived (scrypt) from
 * MAIL_TOKEN_KEY, or from JWT_SECRET when that is not set — so a fresh deploy
 * needs no new env var, but rotating JWT_SECRET also invalidates every stored
 * token (the owner just reconnects; `open` returns null rather than throwing,
 * and the worker treats that as "not connected").
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>" — all base64url, versioned so the
 * scheme can change without breaking rows written under the old one.
 */
const crypto = require('crypto');

let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  const secret = process.env.MAIL_TOKEN_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error('secretBox: set MAIL_TOKEN_KEY or JWT_SECRET');
  cachedKey = crypto.scryptSync(String(secret), 'hrms-mail-identity-v1', 32);
  return cachedKey;
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/**
 * Encrypt a string.
 * @param {string} plain
 * @returns {string} Opaque token safe to store.
 */
function seal(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1.${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(ct)}`;
}

/**
 * Decrypt a value produced by `seal`.
 * @param {string} sealed
 * @returns {string|null} The plaintext, or null when the value is missing,
 *   malformed, or was sealed under a different key.
 */
function open(sealed) {
  if (!sealed) return null;
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), unb64u(parts[1]));
    decipher.setAuthTag(unb64u(parts[2]));
    return Buffer.concat([decipher.update(unb64u(parts[3])), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { seal, open };
