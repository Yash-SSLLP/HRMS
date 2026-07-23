/**
 * Diagnostic: exchange the refresh token for an access token and print ONLY the
 * granted scopes (never the token itself). Helps confirm whether gmail.send was
 * actually granted.
 *
 *   node scripts/checkScopes.js
 */
require('dotenv').config();

(async () => {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Token refresh failed:', json.error_description || json.error || res.status);
    process.exit(1);
  }
  console.log('Granted scopes:');
  for (const s of String(json.scope || '(none)').split(/\s+/)) console.log('  -', s);
  console.log('\nHas gmail.send:', /gmail\.send/.test(json.scope || ''));
})();
