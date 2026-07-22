/**
 * Email transport + outbox enqueue.
 *
 * sendMail()    -- direct delivery; used by the worker.
 * enqueueMail() -- preferred from controllers. Writes to the outbox; the worker
 *                  picks it up, sends with retries, and updates the related entity.
 *
 * If SMTP_HOST is not set, sendMail() logs the message to stdout and returns
 * { mocked: true } so the rest of the flow keeps working in dev.
 */
const nodemailer = require('nodemailer');
const EmailOutbox = require('../models/EmailOutbox');
const storage = require('./storage');

// Map outbox attachment refs to nodemailer attachments. Prefers a storage path
// (streamed from disk), else uses inline base64 bytes embedded in `content`.
function buildAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  const out = attachments
    .filter((a) => a && (a.storagePath || a.content))
    .map((a) => ({
      filename: a.filename || 'attachment',
      content: a.storagePath ? storage.readStream(a.storagePath) : Buffer.from(a.content, 'base64'),
      contentType: a.contentType || undefined,
    }));
  return out.length ? out : undefined;
}

let cachedTransporter;

function buildTransporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

function getTransporter() {
  if (cachedTransporter === undefined) cachedTransporter = buildTransporter();
  return cachedTransporter;
}

// Build the actual From header. SMTP providers (Hostinger included) reject mail
// whose From address is not the authenticated mailbox, so we always send from
// SMTP_FROM/SMTP_USER. If a caller supplied a friendly display name
// (e.g. "Jane HR <jane@personal.com>") we keep the name but swap the address to
// the authenticated mailbox; the caller's own address is preserved via Reply-To.
function resolveFrom(rawFrom) {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@hrms.local';
  if (!rawFrom) return addr;
  const m = /^\s*"?([^"<]*?)"?\s*(?:<[^>]*>)\s*$/.exec(rawFrom);
  const name = m && m[1] ? m[1].trim() : '';
  return name ? `${name} <${addr}>` : addr;
}

async function sendMail(opts) {
  const t = getTransporter();
  const from = resolveFrom(opts.from);
  if (!t) {
    console.log('\n=== EMAIL (SMTP not configured — logging instead) ===');
    console.log('To       :', Array.isArray(opts.to) ? opts.to.join(', ') : opts.to);
    if (opts.cc) console.log('Cc       :', Array.isArray(opts.cc) ? opts.cc.join(', ') : opts.cc);
    console.log('From     :', from);
    console.log('Reply-To :', opts.replyTo || '(none)');
    console.log('Subject  :', opts.subject);
    if (Array.isArray(opts.attachments) && opts.attachments.length) {
      console.log('Attach   :', opts.attachments.map((a) => a.filename).join(', '));
    }
    console.log('--- text ---');
    console.log(opts.text || '(no text body)');
    console.log('====================================================\n');
    return { mocked: true };
  }
  const info = await t.sendMail({
    from,
    to: opts.to,
    cc: opts.cc || undefined,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo,
    attachments: buildAttachments(opts.attachments),
  });
  return { messageId: info.messageId, response: info.response };
}

/**
 * Enqueue an email for asynchronous delivery with retry.
 *
 * @param {Object} opts       to / subject / text / html / from / replyTo
 * @param {Object} [related]  { type: 'exit', id: ObjectId }
 * @returns {Promise<EmailOutbox doc>}
 */
async function enqueueMail(opts, related = {}) {
  const row = await EmailOutbox.create({
    to: Array.isArray(opts.to) ? opts.to.join(',') : opts.to,
    cc: Array.isArray(opts.cc) ? opts.cc.join(',') : opts.cc,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    from: opts.from,
    replyTo: opts.replyTo,
    attachments: opts.attachments,
    status: 'Pending',
    attempts: 0,
    nextAttemptAt: new Date(),
    relatedType: related.type,
    relatedId: related.id,
  });

  // Kick the worker so dev-mode + healthy SMTP cases deliver almost immediately.
  // Lazy-required to avoid circular import.
  try {
    const worker = require('./emailWorker');
    if (worker.tick) setImmediate(() => worker.tick().catch(() => {}));
  } catch (_) { /* worker not started yet — its own interval will catch up */ }

  return row;
}

module.exports = { sendMail, enqueueMail };
