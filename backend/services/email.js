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

// Map outbox attachment refs to nodemailer attachments, streaming from storage.
function buildAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  return attachments
    .filter((a) => a && a.storagePath)
    .map((a) => ({
      filename: a.filename || 'attachment',
      content: storage.readStream(a.storagePath),
      contentType: a.contentType || undefined,
    }));
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

async function sendMail(opts) {
  const t = getTransporter();
  const from = opts.from || process.env.SMTP_FROM || 'no-reply@hrms.local';
  if (!t) {
    console.log('\n=== EMAIL (SMTP not configured — logging instead) ===');
    console.log('To       :', Array.isArray(opts.to) ? opts.to.join(', ') : opts.to);
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
