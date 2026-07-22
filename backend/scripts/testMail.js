/**
 * Quick outgoing-mail smoke test. Sends one email through the same code path the
 * app uses (Gmail API when Google OAuth is configured, else SMTP, else mock).
 *
 * Run (from backend/):
 *   node scripts/testMail.js recipient@example.com
 *
 * A "Gmail send failed: ... insufficient authentication scopes" error means the
 * refresh token still lacks the Gmail scope — re-run getGoogleRefreshToken.js.
 */
require('dotenv').config();
const { sendMail } = require('../services/email');

(async () => {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node scripts/testMail.js recipient@example.com [cc@example.com]');
    process.exit(1);
  }
  const cc = process.argv[3];
  try {
    const info = await sendMail({
      to,
      cc,
      subject: 'HRMS mail test',
      text: 'This is a test email from the HRMS backend. If you received it, outgoing mail works.',
      html: '<p>This is a <strong>test email</strong> from the HRMS backend.</p><p>If you received it, outgoing mail works.</p>',
      replyTo: to,
    });
    console.log('Sent OK:', info);
  } catch (err) {
    console.error('Send FAILED:', err.message);
    process.exit(1);
  }
})();
