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
const googleMail = require('./googleMail');
const { currentUser, als } = require('../middleware/requestContext');

// Map outbox attachment refs to nodemailer attachments. Prefers a storage path
// (read from GridFS), else uses inline base64 bytes embedded in `content`.
//
// Async because `storage.readBuffer` is: the previous version called the
// (equally async) `storage.readStream` WITHOUT awaiting it, so nodemailer was
// handed a Promise as the attachment body and the file went out empty or the
// send failed. Reading the bytes here also lets a missing file drop just that
// attachment instead of failing the whole message.
async function buildAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return undefined;
  const usable = attachments.filter((a) => a && (a.storagePath || a.content));
  const out = [];
  for (const a of usable) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const content = a.storagePath
        ? await storage.readBuffer(a.storagePath)
        : Buffer.from(a.content, 'base64');
      out.push({ filename: a.filename || 'attachment', content, contentType: a.contentType || undefined });
    } catch (err) {
      console.error(`Mail attachment skipped (${a.filename || a.storagePath}):`, err.message);
    }
  }
  return out.length ? out : undefined;
}

/** "a@x, b@y" | ['a@x'] | undefined → ['a@x', 'b@y'] */
function toList(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Copy the person who sent it. Every mail leaves from the company mailbox, so
 * whoever triggered it — the HR emailing an offer letter, an interview invite,
 * a document request, a payslip, a wish — would otherwise have no copy of what
 * went out under their name. Their own address is added as a Cc, taken from
 * the signed-in user of the request that queued or sent the mail. Nothing is
 * added outside a request (crons, public forms), when the actor has no
 * address, when they are already on To/Cc, or when the caller says
 * `selfCopy: false` (the worker: the copy was decided when the row was queued).
 * @param {Object} opts - sendMail/enqueueMail options.
 * @returns {Object} The same options, with the actor's address in `cc` when due.
 */
function withActorCc(opts) {
  if (opts.selfCopy === false) return opts;
  const actor = currentUser();
  const email = String(actor?.email || '').trim();
  if (!email || !/@/.test(email)) return opts;
  const listed = [...toList(opts.to), ...toList(opts.cc)].map((a) => a.toLowerCase());
  if (listed.includes(email.toLowerCase())) return opts;
  return { ...opts, cc: [...toList(opts.cc), email] };
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

// Build the actual From header for SMTP sends. Providers reject mail whose From
// address is not the authenticated mailbox, so we always send from
// SMTP_FROM/SMTP_USER, keeping any caller-supplied display name.
function resolveFrom(rawFrom) {
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@hrms.local';
  if (!rawFrom) return addr;
  const m = /^\s*"?([^"<]*?)"?\s*(?:<[^>]*>)\s*$/.exec(rawFrom);
  const name = m && m[1] ? m[1].trim() : '';
  return name ? `${name} <${addr}>` : addr;
}

/**
 * Deliver one email immediately (used by the outbox worker). Transport priority:
 * Gmail API when Google OAuth is configured, else SMTP via nodemailer, else a
 * dev-mode stdout log that returns { mocked: true } so flows keep working.
 * @param {Object} opts - { to, cc, subject, text, html, from, replyTo, attachments }.
 * @returns {Promise<{messageId?:string, response?:string, mocked?:boolean}>} Provider result.
 * @throws {Error} If the chosen transport fails to send.
 * @sideEffects Sends a real email (network) except in the mocked/log path.
 */
async function sendMail(opts) {
  opts = withActorCc(opts);
  // Preferred transport: Gmail API via the shared Google OAuth credentials.
  // isConfigured() only means the env vars are PRESENT — the refresh token can
  // still be revoked or expired. When it is (err.permanent), fall through to
  // SMTP if one is configured rather than failing outright, so a dead Google
  // credential doesn't take mail down completely.
  if (googleMail.isConfigured()) {
    try {
      return await googleMail.send(opts);
    } catch (err) {
      if (!err.permanent || !process.env.SMTP_HOST) throw err;
      console.error(
        '[email] Google credentials are no longer valid — falling back to SMTP. '
        + 'Re-authorise with: node scripts/getGoogleRefreshToken.js'
      );
    }
  }

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
    attachments: await buildAttachments(opts.attachments),
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
  // Decided HERE, inside the request that knows who is sending; the worker
  // that delivers the row later has no request to ask.
  opts = withActorCc(opts);
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
    // Run the tick OUTSIDE this request's context: AsyncLocalStorage follows
    // setImmediate, the tick drains every due row — other people's included —
    // and withActorCc must never see this request's user while doing so.
    if (worker.tick) setImmediate(() => als.exit(() => worker.tick().catch(() => {})));
  } catch (_) { /* worker not started yet — its own interval will catch up */ }

  return row;
}

module.exports = { sendMail, enqueueMail };
