/**
 * Connecting a person's own Google mailbox so the mail THEY trigger leaves
 * from their address (User.mailIdentity). See services/mailIdentity for who may,
 * and services/emailWorker for how a queued mail picks the mailbox.
 *
 * Flow: the account page POSTs /google/start and is sent to Google's consent
 * screen; Google redirects the browser to GET /google/callback on THIS server,
 * which stores the grant and bounces the browser back to the web app with
 * ?mail=connected (or ?mail=error&reason=…). The callback is unauthenticated
 * — it arrives from Google, not from our SPA — so the `state` parameter is a
 * short-lived JWT naming the user, and nothing else identifies them.
 *
 * Google Cloud Console must list the exact callback URL as an authorised
 * redirect URI for the OAuth client. GET / returns the URL this server expects,
 * so a Super Admin can copy it from the account page rather than guess.
 */
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const googleOAuth = require('../services/googleOAuth');
const googleMail = require('../services/googleMail');
const mailIdentity = require('../services/mailIdentity');
const { appBaseUrl } = require('../config/appUrl');

const strip = (u) => String(u || '').trim().replace(/\/+$/, '');

/**
 * The public origin of THIS API, for the OAuth callback URL. Behind Render /
 * a reverse proxy the socket is plain http while the world sees https, so the
 * forwarded headers win over req.protocol. API_PUBLIC_URL overrides everything.
 * @param {import('express').Request} req
 * @returns {string} e.g. "https://api.example.com"
 */
function apiOrigin(req) {
  const explicit = strip(process.env.API_PUBLIC_URL);
  if (explicit) return explicit;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

/** @returns {string} The redirect URI registered with Google for this server. */
function redirectUri(req) {
  return strip(process.env.GOOGLE_OAUTH_MAIL_REDIRECT_URI) || `${apiOrigin(req)}/api/mail-identity/google/callback`;
}

// Where to send the browser after the dance: a relative path inside our own
// app, never anything an attacker could put a foreign origin in.
const DEFAULT_RETURN = '/admin/account';
function safeReturnTo(p) {
  return typeof p === 'string' && /^\/[^\s]*$/.test(p) && !p.startsWith('//') ? p : DEFAULT_RETURN;
}

function statusOf(user) {
  const mi = user.mailIdentity || {};
  return {
    connected: Boolean(mi.email),
    email: mi.email || null,
    connectedAt: mi.connectedAt || null,
    lastSentAt: mi.lastSentAt || null,
    lastError: mi.lastError || null,
    lastErrorAt: mi.lastErrorAt || null,
  };
}

/** Gate: only roles that send on the company's behalf may connect a mailbox. */
function requireSender(req, res, next) {
  if (!mailIdentity.canSend(req.user)) {
    res.status(403);
    return next(new Error('Your account does not send email from HRMS, so there is no mailbox to connect.'));
  }
  return next();
}

/**
 * @route GET /api/mail-identity  (sender roles)
 * @returns {{allowed:boolean, available:boolean, companySender:string|null,
 *   redirectUri:string, connected:boolean, email:string|null, connectedAt, lastSentAt,
 *   lastError, lastErrorAt}}
 */
const getStatus = asyncHandler(async (req, res) => {
  res.json({
    allowed: mailIdentity.canSend(req.user),
    available: googleOAuth.hasClient(),
    companySender: process.env.GOOGLE_MAIL_SENDER || null,
    redirectUri: redirectUri(req),
    ...statusOf(req.user),
  });
});

/**
 * @route POST /api/mail-identity/google/start  (sender roles)
 * @param {string} [req.body.returnTo] - App path to land on afterwards.
 * @returns {{url:string, redirectUri:string}} Google consent URL to navigate to.
 */
const startConnect = asyncHandler(async (req, res) => {
  if (!googleOAuth.hasClient()) {
    res.status(503);
    throw new Error('Google sign-in is not configured on the server (GOOGLE_OAUTH_CLIENT_ID / _SECRET).');
  }
  const uri = redirectUri(req);
  // The phone app cannot be redirected to like a web page: it hands the person
  // to the system browser, and the browser is where Google sends them back. So
  // a mobile-started flow ends on a small landing page whose button deep-links
  // into the app (mobileLandingPage below); a web flow goes back to the SPA
  // path it came from. Which one is fixed here, inside the signed state, so the
  // callback cannot be talked into the other by anything on the query string.
  const client = req.body?.client === 'mobile' ? 'mobile' : 'web';
  const state = jwt.sign(
    { uid: String(req.user._id), purpose: 'mail-identity', uri, client, returnTo: safeReturnTo(req.body?.returnTo) },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({
    url: googleOAuth.mailboxConsentUrl({ redirectUri: uri, state, loginHint: req.user.email }),
    redirectUri: uri,
  });
});

/**
 * @route GET /api/mail-identity/google/callback?code&state  (public: Google redirects here)
 * Stores the grant on the user named in `state`, then redirects the browser to
 * the web app with ?mail=connected&email=… or ?mail=error&reason=….
 */
const finishConnect = asyncHandler(async (req, res) => {
  let claims = null;
  try {
    claims = jwt.verify(String(req.query.state || ''), process.env.JWT_SECRET);
    if (claims.purpose !== 'mail-identity' || !claims.uid || !claims.uri) throw new Error('bad state');
  } catch (_) {
    claims = null;
  }

  // Where the outcome goes: the app's landing page for a mobile-started flow,
  // otherwise back to the web app path the flow came from.
  const back = (params) => {
    if (claims?.client === 'mobile') {
      res.set('Cache-Control', 'no-store').type('html').send(mobileLandingPage(params));
      return;
    }
    const url = new URL(safeReturnTo(claims?.returnTo), `${appBaseUrl()}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res.redirect(url.toString());
  };

  if (!claims) return back({ mail: 'error', reason: 'The Google sign-in link expired. Please try again.' });

  if (req.query.error) {
    const reason = req.query.error === 'access_denied'
      ? 'You cancelled the Google sign-in, so nothing was connected.'
      : `Google refused the sign-in (${req.query.error}).`;
    return back({ mail: 'error', reason });
  }

  try {
    const { accessToken, refreshToken, scope } = await googleOAuth.exchangeCode(String(req.query.code || ''), claims.uri);
    if (!/gmail\.send/.test(scope)) {
      await googleOAuth.revokeToken(refreshToken);
      throw new Error('You did not allow HRMS to send email. Tick "Send email on your behalf" on the Google screen and try again.');
    }
    const info = await googleOAuth.fetchUserInfo(accessToken);
    await mailIdentity.connect(claims.uid, { email: info.email, refreshToken });
    return back({ mail: 'connected', email: info.email });
  } catch (err) {
    console.error('[mailIdentity] connect failed:', err.message);
    return back({ mail: 'error', reason: err.message });
  }
});

// The Android app's URL scheme — `expo.scheme` in mobile/app.json, wired into
// the manifest's intent filter. `<scheme>://mail-identity?…` reopens the app and
// components/SenderMailboxCard reads the outcome off it.
const MOBILE_SCHEME = String(process.env.MOBILE_APP_SCHEME || 'ssllphrms').replace(/[^a-z0-9.+-]/gi, '');

const escapeHtml = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The page a phone lands on after Google. It cannot be the SPA — the app has
 * no web session in the phone's browser — so it is a self-contained screen with
 * one job: send the person back into the app, carrying the outcome. The script
 * tries the deep link on its own, but Android Chrome only honours a custom
 * scheme on a tap, so the button is the path that always works; and the app
 * refetches when it returns to the foreground regardless, so even "just switch
 * back" ends with the card showing the truth.
 * @param {{mail:'connected'|'error', email?:string, reason?:string}} params
 * @returns {string} HTML
 */
function mobileLandingPage(params) {
  const ok = params.mail === 'connected';
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const deepLink = `${MOBILE_SCHEME}://mail-identity?${query}`;
  const title = ok ? 'Mailbox connected' : 'Could not connect';
  const body = ok
    ? `Emails you send from HRMS will now leave from <b>${escapeHtml(params.email)}</b>.`
    : escapeHtml(params.reason || 'Google did not complete the sign-in.');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · HRMS</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f4f6;color:#111827;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  main{background:#fff;border-radius:16px;padding:28px 24px;max-width:420px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}
  .icon{width:56px;height:56px;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#fff;background:${ok ? '#16a34a' : '#d97706'}}
  h1{font-size:20px;margin:0 0 8px}
  p{font-size:15px;line-height:1.5;color:#374151;margin:0 0 20px}
  a.btn{display:block;background:#C7A24C;color:#1a1a1a;text-decoration:none;font-weight:700;font-size:16px;padding:14px 18px;border-radius:12px}
  .hint{font-size:12px;color:#6b7280;margin:14px 0 0}
</style></head>
<body><main>
  <div class="icon">${ok ? '&#10003;' : '!'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${body}</p>
  <a class="btn" href="${escapeHtml(deepLink)}">Back to the HRMS app</a>
  <p class="hint">If the button does nothing, just switch back to the HRMS app — it picks up the change on its own.</p>
</main>
<script>setTimeout(function(){try{location.href=${JSON.stringify(deepLink)}}catch(e){}},700);</script>
</body></html>`;
}

/**
 * @route DELETE /api/mail-identity  (sender roles)
 * Revokes the grant at Google and forgets it. Mail returns to the company mailbox.
 */
const disconnect = asyncHandler(async (req, res) => {
  await mailIdentity.disconnect(req.user._id);
  res.json({ ok: true, connected: false, email: null });
});

/**
 * @route POST /api/mail-identity/test  (sender roles)
 * Sends a short mail from the person's connected mailbox to that same address,
 * synchronously, so the account page can show the real outcome at once.
 * @returns {{ok:true, to:string, messageId?:string}}
 */
const sendTest = asyncHandler(async (req, res) => {
  const identity = await mailIdentity.resolveIdentity(req.user._id);
  if (!identity) {
    res.status(400);
    throw new Error(req.user.mailIdentity?.lastError
      ? 'Google has refused your connection. Reconnect your Google account and try again.'
      : 'Connect your Google account first.');
  }
  try {
    const info = await googleMail.send({
      to: identity.email,
      subject: 'HRMS: your mailbox is connected',
      text: `Hi ${identity.name || 'there'},\n\nThis test was sent from HRMS through your own Google account (${identity.email}). `
        + 'Every email you send from HRMS from now on — letters, payslips, interview invites — will leave from this address.\n\n'
        + 'You can disconnect it any time from My Account.',
      identity,
    });
    await mailIdentity.markSent(identity.userId);
    res.json({ ok: true, to: identity.email, messageId: info.messageId });
  } catch (err) {
    if (err.permanent) await mailIdentity.markBroken(identity.userId, err.message);
    res.status(502);
    throw new Error(`Could not send from ${identity.email}: ${err.message}`);
  }
});

module.exports = { requireSender, getStatus, startConnect, finishConnect, disconnect, sendTest };
