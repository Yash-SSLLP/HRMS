/**
 * Google OAuth plumbing shared by the company credential (services/googleCalendar,
 * services/googleMail) and each person's own connected mailbox
 * (services/mailIdentity). Zero-dependency: global fetch only.
 *
 * One OAuth client (GOOGLE_OAUTH_CLIENT_ID / _SECRET) serves every grant. What
 * differs is the refresh token: the company one lives in the env, a person's
 * lives encrypted on their User record. Both go through `refreshAccessToken`,
 * which caches the short-lived access token per refresh token.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

// What a connected personal mailbox needs: send mail, tell us which address it
// is (so the From header and the account page can name it), and add events to
// the person's own calendar — an interview's Meet invitation then comes from
// them like every other mail they send. No mail-READ scope, ever.
const MAILBOX_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events',
];

/** @returns {boolean} True when an OAuth client (id + secret) is configured. */
function hasClient() {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

// Access tokens by cache key ("company", or "user:<id>"). Each entry lives
// until shortly before Google's expiry; a bounded map because the set of
// keys is the set of connected people, which is small.
const cache = new Map();

/**
 * Exchange a refresh token for a short-lived access token, cached per key.
 * @param {string} refreshToken
 * @param {string} cacheKey - Stable name for this grant ("company", "user:<id>").
 * @returns {Promise<string>} Bearer access token.
 * @throws {Error} With `permanent: true` when Google answers invalid_grant —
 *   the token is expired, revoked, or issued to another client; only a human
 *   re-consenting fixes that, so callers must not retry.
 */
async function refreshAccessToken(refreshToken, cacheKey) {
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt - 60_000) return hit.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || res.status;
    const err = new Error(`Google OAuth token refresh failed: ${detail}`);
    // NOTE: if the Google Cloud consent screen is still in "Testing", refresh
    // tokens expire after 7 days; publish the app to stop this recurring.
    if (json.error === 'invalid_grant') err.permanent = true;
    throw err;
  }
  cache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 });
  return json.access_token;
}

/** Drop a cached access token (after a disconnect or a re-consent). */
function forget(cacheKey) {
  cache.delete(cacheKey);
}

/**
 * The consent URL a person is sent to so they can connect their own mailbox.
 * @param {{redirectUri:string, state:string, loginHint?:string}} p
 * @returns {string}
 */
function mailboxConsentUrl({ redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: MAILBOX_SCOPES.join(' '),
    access_type: 'offline',
    // Always re-prompt: Google only returns a refresh token on a consent
    // screen, and a silent re-authorisation would leave us with nothing to store.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params}`;
}

/**
 * Turn the authorisation code from the callback into tokens.
 * @param {string} code
 * @param {string} redirectUri - Must equal the one used in the consent URL.
 * @returns {Promise<{accessToken:string, refreshToken:string, scope:string}>}
 */
async function exchangeCode(code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Google sign-in failed: ${json.error_description || json.error || res.status}`);
  }
  if (!json.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove HRMS under '
      + 'myaccount.google.com/permissions and connect again.');
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, scope: json.scope || '' };
}

/**
 * The Google account behind an access token.
 * @param {string} accessToken
 * @returns {Promise<{email:string, verified:boolean}>}
 */
async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.email) throw new Error('Could not read the Google account address.');
  return { email: String(json.email).toLowerCase(), verified: json.email_verified !== false };
}

/**
 * Tell Google to forget a grant. Best effort: a token that is already dead
 * makes this a no-op, and the caller clears its own copy regardless.
 * @param {string} token - Refresh or access token.
 * @returns {Promise<void>}
 */
async function revokeToken(token) {
  if (!token) return;
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch (_) { /* ignore */ }
}

module.exports = {
  hasClient,
  refreshAccessToken,
  forget,
  mailboxConsentUrl,
  exchangeCode,
  fetchUserInfo,
  revokeToken,
  MAILBOX_SCOPES,
};
