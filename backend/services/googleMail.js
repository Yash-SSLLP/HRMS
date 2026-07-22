/**
 * Send email through the Gmail API using the same Google OAuth credentials as the
 * Calendar/Meet integration (services/googleCalendar.js) — no SMTP required.
 *
 * The refresh token MUST have been granted a Gmail send scope in addition to the
 * calendar scope. Re-run scripts/getGoogleRefreshToken.js (its SCOPE now includes
 * https://www.googleapis.com/auth/gmail.send) and enable the "Gmail API" for the
 * project in Google Cloud Console.
 *
 * Gmail always sends *from* the authenticated account. We keep the caller's
 * friendly display name but the address is the authenticated mailbox; the
 * caller's own address is preserved as Reply-To.
 */
const storage = require('./storage');
const { isConfigured, getAccessToken } = require('./googleCalendar');

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Cache the authenticated sender address (derived from the Gmail profile) so we
// don't hit the profile endpoint on every send.
let cachedSender = process.env.GOOGLE_MAIL_SENDER || null;

async function getSenderAddress() {
  if (cachedSender) return cachedSender;
  const token = await getAccessToken();
  const res = await fetch(`${GMAIL_API}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.emailAddress) {
    throw new Error(`Gmail profile lookup failed: ${json.error?.message || res.status}`);
  }
  cachedSender = json.emailAddress;
  return cachedSender;
}

// RFC 2047 encode a header value when it contains non-ASCII characters.
function encodeHeader(value) {
  const s = String(value || '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Build a From header: keep the display name (if the caller passed one) but use
// the authenticated sender address.
function buildFrom(rawFrom, senderAddr) {
  if (!rawFrom) return senderAddr;
  const m = /^\s*"?([^"<]*?)"?\s*(?:<[^>]*>)?\s*$/.exec(rawFrom);
  const name = m && m[1] ? m[1].trim() : '';
  return name ? `${encodeHeader(name)} <${senderAddr}>` : senderAddr;
}

// Wrap base64 into 76-char lines as required by MIME.
function chunk76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

function attachmentBytes(a) {
  if (a.storagePath) return storage.readBuffer(a.storagePath);
  if (a.content) return Buffer.from(a.content, 'base64');
  return null;
}

// Assemble a raw RFC 2822 MIME message (multipart/mixed with a plain/html
// alternative body plus any attachments) and base64url-encode it for Gmail.
function buildRawMessage({ from, to, cc, replyTo, subject, text, html, attachments }) {
  const boundary = `bnd_${Buffer.from(String(subject || 'mail')).toString('hex').slice(0, 16)}_x`;
  const altBoundary = `alt_${boundary}`;
  const files = (attachments || []).map((a) => ({ meta: a, bytes: attachmentBytes(a) })).filter((f) => f.bytes);

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(`Subject: ${encodeHeader(subject)}`);
  headers.push('MIME-Version: 1.0');
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const lines = [headers.join('\r\n'), ''];

  // Body part: use a nested multipart/alternative when HTML is present.
  lines.push(`--${boundary}`);
  if (html) {
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`, '');
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
    lines.push(chunk76(Buffer.from(text || '', 'utf8').toString('base64')));
    lines.push(`--${altBoundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
    lines.push(chunk76(Buffer.from(html, 'utf8').toString('base64')));
    lines.push(`--${altBoundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
    lines.push(chunk76(Buffer.from(text || '', 'utf8').toString('base64')));
  }

  for (const f of files) {
    const name = encodeHeader(f.meta.filename || 'attachment');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${f.meta.contentType || 'application/octet-stream'}; name="${name}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${name}"`, '');
    lines.push(chunk76(f.bytes.toString('base64')));
  }
  lines.push(`--${boundary}--`, '');

  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function send(opts) {
  const token = await getAccessToken();
  const senderAddr = await getSenderAddress();
  const raw = buildRawMessage({
    from: buildFrom(opts.from, senderAddr),
    to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
    cc: Array.isArray(opts.cc) ? opts.cc.join(', ') : opts.cc,
    replyTo: opts.replyTo,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
  });

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gmail send failed: ${json.error?.message || res.status}`);
  }
  return { messageId: json.id, response: 'gmail:ok' };
}

module.exports = { isConfigured, send };
