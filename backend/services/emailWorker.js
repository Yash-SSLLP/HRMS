/**
 * In-process worker for the email outbox.
 *
 * - Polls every POLL_INTERVAL_MS for due rows
 * - Atomically claims one with findOneAndUpdate so multiple workers (or a worker
 *   + an immediate tick triggered by enqueue) don't double-send
 * - Recovers stale 'Sending' rows whose lock is older than STALE_LOCK_MS
 * - Exponential backoff between attempts; marks 'Dead' after maxAttempts
 * - On success/failure, mirrors state back to the originating entity (e.g. ExitRequest)
 */
const EmailOutbox = require('../models/EmailOutbox');
const ExitRequest = require('../models/ExitRequest');
const Candidate = require('../models/Candidate');
const { sendMail } = require('./email');
const mailIdentity = require('./mailIdentity');
const { notify } = require('./notify');

const POLL_INTERVAL_MS = 30_000;            // 30s
const STALE_LOCK_MS = 2 * 60_000;           // claim back rows stuck in 'Sending' > 2 min
const MAX_PER_TICK = 5;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 43200]; // 1m, 5m, 30m, 2h, 6h, 12h

let intervalHandle = null;
let ticking = false;

/**
 * Send one outbox row from the right mailbox. A row with a `sender` is that
 * person's mail and leaves from THEIR connected Google account — and from
 * nowhere else: if the connection is gone or Google refuses it, the row dies
 * with a reason and the sender is told in-app, rather than the mail quietly
 * going out from the company mailbox under their name. A row without a sender
 * is the system's and takes the company mailbox.
 * @param {Object} row - EmailOutbox document.
 * @returns {Promise<{messageId?:string, sentFrom?:string, mocked?:boolean}>}
 * @sideEffects Sends email; may stamp User.mailIdentity and create a Notification.
 */
async function deliver(row) {
  const base = {
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    text: row.text,
    html: row.html,
    from: row.from,
    replyTo: row.replyTo,
    attachments: row.attachments,
    // Never derive a sender from the request context in here: a tick can run
    // inside whichever request kicked it, and that person is not this row's.
    sender: null,
  };
  if (!row.sender) return sendMail(base);

  const { identity, reason } = await mailIdentity.loadIdentity(row.sender);
  if (!identity) {
    const err = new Error(reason === 'broken' || reason === 'unreadable'
      ? 'Google no longer accepts the sender\'s mailbox connection.'
      : 'The sender has not connected a Google mailbox.');
    err.permanent = true;
    err.hint = 'reconnect';
    await tellSender(row, err.message);
    throw err;
  }
  try {
    return await sendMail({ ...base, identity });
  } catch (err) {
    if (err.permanent) await tellSender(row, err.message);
    throw err;
  }
}

/**
 * Tell the person whose mail just died, in-app, so a refused mailbox never
 * turns into a candidate who was silently never written to.
 * @param {Object} row - The dead EmailOutbox row.
 * @param {string} reason
 * @returns {Promise<void>} Never rejects.
 */
async function tellSender(row, reason) {
  try {
    await notify({
      recipient: row.sender,
      type: 'general',
      audience: 'all',
      title: 'Email not sent',
      body: `"${row.subject}" to ${row.to} did not go out: ${reason} `
        + 'Reconnect your mailbox under My Account → "Send email from your own mailbox" and send it again.',
    });
  } catch (err) {
    console.error('[emailWorker] could not notify the sender:', err.message);
  }
}

/**
 * Atomically claim and process the single most-due outbox row: mark it Sending,
 * send via services/email.sendMail, then record Sent, or apply exponential
 * backoff (marking Dead after maxAttempts). Stale 'Sending' locks older than
 * STALE_LOCK_MS are reclaimed. Mirrors the outcome back to the related entity.
 * @returns {Promise<Object|null>} The processed EmailOutbox row, or null when nothing was due.
 * @sideEffects Sends email; updates EmailOutbox and the related entity (ExitRequest/Candidate).
 */
async function processOne() {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_LOCK_MS);

  const row = await EmailOutbox.findOneAndUpdate(
    {
      $or: [
        { status: 'Pending', nextAttemptAt: { $lte: now } },
        { status: 'Sending', lockedAt: { $lt: staleCutoff } },
      ],
    },
    { $set: { status: 'Sending', lockedAt: now } },
    { new: true, sort: { nextAttemptAt: 1 } }
  );
  if (!row) return null;

  try {
    const info = await deliver(row);

    row.status = 'Sent';
    row.sentAt = new Date();
    row.lastAttemptAt = row.sentAt;
    row.messageId = info.messageId || (info.mocked ? 'mocked' : undefined);
    row.sentFrom = info.sentFrom || (info.mocked ? 'mocked' : undefined);
    row.lastError = undefined;
    row.attempts = (row.attempts || 0) + 1;
    await row.save();

    await mirrorToRelated(row, { sent: true });
  } catch (err) {
    row.attempts = (row.attempts || 0) + 1;
    row.lastError = err.message || String(err);
    row.lastAttemptAt = new Date();
    // A revoked/expired credential will never succeed on retry. Retrying it
    // walks the whole backoff ladder (1m → 12h) before giving up, and every
    // later message queues behind it — so fail fast and say what to do.
    if (err.permanent) {
      row.status = 'Dead';
      row.lastError = `${row.lastError} — not retried: ${err.hint === 'reconnect'
        ? 'the sender must reconnect their mailbox under My Account and send again.'
        : 're-authorise with node scripts/getGoogleRefreshToken.js, then restart the server.'}`;
    } else if (row.attempts >= (row.maxAttempts || 6)) {
      row.status = 'Dead';
    } else {
      const idx = Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1);
      row.nextAttemptAt = new Date(Date.now() + BACKOFF_SECONDS[idx] * 1000);
      row.status = 'Pending';
    }
    await row.save();

    await mirrorToRelated(row, { sent: false, error: row.lastError });
    console.warn(
      `[emailWorker] send failed (attempt ${row.attempts}/${row.maxAttempts}): ${row.lastError}`
    );
  }
  return row;
}

/**
 * Reflect a send outcome onto the entity that queued the mail so its own UI shows
 * the delivery state. Currently handles 'exit' (ExitRequest email status fields)
 * and 'offer'/'appointment' (Candidate letter emailedAt stamps).
 * @param {Object} row - The EmailOutbox row (carries relatedType/relatedId + timestamps).
 * @param {{sent:boolean, error?:string}} outcome - Whether the send succeeded and any error text.
 * @returns {Promise<void>}
 * @sideEffects Updates the ExitRequest or Candidate collection.
 */
async function mirrorToRelated(row, outcome) {
  if (!row.relatedType || !row.relatedId) return;
  if (row.relatedType === 'exit') {
    const patch = { exitEmailLastAttemptAt: row.lastAttemptAt };
    if (outcome.sent) {
      patch.exitEmailSentAt = row.sentAt;
      patch.exitEmailMessageId = row.messageId;
      patch.exitEmailLastError = undefined;
    } else {
      patch.exitEmailLastError = outcome.error;
    }
    await ExitRequest.updateOne({ _id: row.relatedId }, { $set: patch });
  }
  // Stamp when an offer / appointment letter email actually went out.
  if (outcome.sent && (row.relatedType === 'offer' || row.relatedType === 'appointment')) {
    const field = row.relatedType === 'offer' ? 'offer.emailedAt' : 'appointment.emailedAt';
    await Candidate.updateOne({ _id: row.relatedId }, { $set: { [field]: row.sentAt } });
  }
  // Add other related types here as new modules use the outbox
}

/**
 * Drain up to MAX_PER_TICK due rows in one pass, stopping early when none remain.
 * Re-entrancy guarded by the module `ticking` flag.
 * @returns {Promise<void>}
 * @sideEffects See processOne (sends email, DB writes).
 */
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const done = await processOne();
      if (!done) break;
    }
  } finally {
    ticking = false;
  }
}

/**
 * Start the outbox worker: poll every POLL_INTERVAL_MS plus an immediate tick to
 * drain anything queued during downtime. No-op if already running.
 * @returns {void}
 */
/**
 * Check the configured mail transport once at boot and say plainly whether mail
 * can actually go out. Without this, a revoked Google token is invisible until
 * someone notices that an email never arrived — the failure previously showed up
 * only as a warn line buried among the retry attempts.
 * @returns {Promise<void>} Never rejects; this is a diagnostic, not a gate.
 */
async function reportTransportHealth() {
  try {
    const googleMail = require('./googleMail');
    if (!googleMail.isConfigured()) {
      if (!process.env.SMTP_HOST) {
        console.warn('[emailWorker] No mail transport configured — email is logged to stdout, NOT delivered.');
      }
      return;
    }
    const { getAccessToken } = require('./googleCalendar');
    await getAccessToken();
    console.log(`[emailWorker] Gmail transport OK.${process.env.SMTP_HOST ? ' SMTP backup configured.' : ''}`);
  } catch (err) {
    const covered = err.permanent && process.env.SMTP_HOST;
    console.error(
      `\n[emailWorker] ******** GMAIL TRANSPORT ${covered ? 'DOWN (SMTP backup active)' : 'NOT WORKING'} ********\n`
      + `  ${err.message}\n`
      + (err.permanent
        ? '  The Google refresh token is expired or revoked. Fix:\n'
          + '    1) node scripts/getGoogleRefreshToken.js\n'
          + '    2) put the new GOOGLE_OAUTH_REFRESH_TOKEN in backend/.env\n'
          + '    3) restart the server\n'
          + '  If this keeps happening weekly, the Google Cloud OAuth consent screen is\n'
          + '  still in "Testing" — tokens expire after 7 days until the app is published.\n'
        : '  Transient error — the worker will keep retrying.\n')
      + (covered
        ? `  Mail is still going out via SMTP (${process.env.SMTP_HOST}) until Google is fixed.\n`
        : err.permanent
          ? '  No SMTP backup is configured, so NO mail is being delivered.\n'
            + '  Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM in backend/.env to cover this.\n'
          : '')
      + '  ***************************************\n'
    );
  }
}

function startWorker() {
  if (intervalHandle) return;
  reportTransportHealth();
  intervalHandle = setInterval(() => {
    tick().catch((e) => console.error('[emailWorker] tick error:', e.message));
  }, POLL_INTERVAL_MS);
  // Drain anything queued during downtime
  tick().catch((e) => console.error('[emailWorker] initial tick error:', e.message));
  console.log(`[emailWorker] started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop the polling interval (in-flight ticks are not interrupted).
 * @returns {void}
 */
function stopWorker() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startWorker, stopWorker, tick, processOne };
