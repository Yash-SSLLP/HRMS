// Email-compose helpers: build public backend URLs for outsider-facing links
// and open a prefilled Gmail web compose tab (attachments are downloaded
// locally since webmail cannot pre-attach files).
import { downloadFile } from './download';

// Absolute backend URL for building public links shared with outsiders (e.g. a
// candidate's letter-download link). Prefers the deployed backend; falls back to
// localhost for dev.
const BACKEND_BASE = (import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000').replace(/\/+$/, '');
export const apiPublicUrl = (path) => `${BACKEND_BASE}/api${path.startsWith('/') ? path : `/${path}`}`;

/**
 * Open a prefilled email in a new browser tab (Gmail web compose) with the
 * subject and body filled in, and download any attachments.
 *
 * NOTE: neither `mailto:` nor any webmail compose URL can pre-attach files —
 * browsers forbid it for security. So we download the attachment(s) to the
 * user's device and they drag them into the compose window before sending.
 * The message body reminds them to do so.
 *
 * @param {Object} opts
 * @param {string}  opts.to          recipient email
 * @param {string} [opts.subject]
 * @param {string} [opts.body]
 * @param {string} [opts.cc]
 * @param {string} [opts.bcc]
 * @param {Array<{url:string, filename:string}>} [opts.attachments]
 */
export async function composeMail({ to, subject = '', body = '', cc, bcc, attachments = [] }) {
  const params = new URLSearchParams({ view: 'cm', fs: '1' });
  if (to) params.set('to', to);
  if (cc) params.set('cc', cc);
  if (bcc) params.set('bcc', bcc);
  params.set('su', subject);
  params.set('body', body);

  // Open synchronously inside the click gesture so popup blockers allow it.
  window.open(`https://mail.google.com/mail/?${params.toString()}`, '_blank', 'noopener');

  // Then pull the attachments into the Downloads folder (best effort).
  for (const a of attachments) {
    try { await downloadFile(a.url, a.filename); } catch (_) { /* ignore */ }
  }
}
