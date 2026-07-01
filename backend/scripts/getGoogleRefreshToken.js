/**
 * One-time helper to obtain a Google OAuth *refresh token* for the Calendar/Meet
 * integration (services/googleCalendar.js).
 *
 * Prerequisites (Google Cloud Console, https://console.cloud.google.com):
 *   1. Enable the "Google Calendar API" for your project.
 *   2. Create an OAuth 2.0 Client ID of type "Web application".
 *   3. Add this Authorized redirect URI EXACTLY:
 *        http://localhost:5055/oauth2callback
 *   4. On the OAuth consent screen, add your Google account as a Test user
 *      (or publish the app).
 *
 * Run (from backend/):
 *   GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy node scripts/getGoogleRefreshToken.js
 *
 * It prints a consent URL — open it, sign in as the account that should OWN the
 * interview meetings, approve, and the script prints your GOOGLE_OAUTH_REFRESH_TOKEN.
 */
require('dotenv').config();
const http = require('http');
const { URL } = require('url');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:5055/oauth2callback';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

console.log('\n1) Open this URL in your browser and approve access:\n');
console.log(authUrl);
console.log('\n2) Waiting for the redirect on http://localhost:5055 ...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No code in callback.');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const json = await tokenRes.json();
    if (!json.refresh_token) {
      throw new Error(
        'No refresh_token returned. Revoke prior access at ' +
          'https://myaccount.google.com/permissions and retry (prompt=consent is set).'
      );
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Success! You can close this tab and return to the terminal.');
    console.log('\n=== SUCCESS ===');
    console.log('Add this to your backend env (Railway → Variables, and local .env):\n');
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${json.refresh_token}\n`);
  } catch (err) {
    res.writeHead(500).end('Error: ' + err.message);
    console.error('\nFailed:', err.message);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(5055);
