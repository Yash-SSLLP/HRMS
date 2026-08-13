/**
 * The public base URL of the WEB app.
 *
 * Used to build links we email to people OUTSIDE the company — candidates
 * (offer/appointment letters, document upload), leavers (exit feedback). Getting
 * it wrong fails silently and totally: the mail sends, the recipient sees a link,
 * and it is dead. A localhost link in a candidate's inbox is exactly that bug.
 *
 * This lived as three separate `process.env.APP_BASE_URL || 'http://localhost:5173'`
 * copies (recruitment, exit, admin controllers) which disagreed on trailing-slash
 * handling, and every one of them defaulted to localhost — including in production,
 * where that default is never right.
 *
 * Resolution order:
 *   1. APP_BASE_URL                  — the explicit answer; always wins.
 *   2. CORS_ORIGIN                   — in production only, and only when it is a
 *                                      real remote https origin. This is already
 *                                      the deployed frontend, so it is the same
 *                                      value by definition.
 *   3. PROD_FALLBACK                 — in production only. A wrong-but-reachable
 *                                      URL beats a guaranteed-dead localhost one.
 *   4. http://localhost:5173         — development only.
 *
 * Falling past (1) in production is a misconfiguration, so it warns once rather
 * than failing the send: the letter PDF is attached to those mails as well, and
 * killing delivery over a bad link would be worse than delivering the attachment.
 */

// The deployed web app. Same origin the mobile app ships as `webBaseUrl`
// (mobile/app.json) and the frontend builds against.
const PROD_FALLBACK = 'https://hrms-orpin-gamma.vercel.app';
const DEV_FALLBACK = 'http://localhost:5173';

const strip = (u) => String(u || '').trim().replace(/\/+$/, '');
const isRemoteHttps = (u) => /^https:\/\//i.test(u) && !/localhost|127\.0\.0\.1/i.test(u);

let warned = false;
function warnOnce(used) {
  if (warned) return;
  warned = true;
  console.error(
    '[appUrl] APP_BASE_URL is not set. Falling back to %s for emailed links. ' +
    'Set APP_BASE_URL on the server to the public web app URL — links in ' +
    'candidate/leaver emails are built from it.',
    used
  );
}

/**
 * @returns {string} Base URL with no trailing slash, e.g. "https://app.example.com".
 */
function appBaseUrl() {
  const explicit = strip(process.env.APP_BASE_URL);
  if (explicit) return explicit;

  if (process.env.NODE_ENV === 'production') {
    const cors = strip(process.env.CORS_ORIGIN);
    // CORS_ORIGIN may be a comma-separated list or '*'; only a single concrete
    // https origin is meaningful as a link target.
    const candidate = cors.includes(',') ? '' : cors;
    if (isRemoteHttps(candidate)) {
      warnOnce(candidate);
      return candidate;
    }
    warnOnce(PROD_FALLBACK);
    return PROD_FALLBACK;
  }

  return DEV_FALLBACK;
}

module.exports = { appBaseUrl, PROD_FALLBACK, DEV_FALLBACK };
