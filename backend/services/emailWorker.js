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
const { sendMail } = require('./email');

const POLL_INTERVAL_MS = 30_000;            // 30s
const STALE_LOCK_MS = 2 * 60_000;           // claim back rows stuck in 'Sending' > 2 min
const MAX_PER_TICK = 5;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600, 43200]; // 1m, 5m, 30m, 2h, 6h, 12h

let intervalHandle = null;
let ticking = false;

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
    const info = await sendMail({
      to: row.to,
      subject: row.subject,
      text: row.text,
      html: row.html,
      from: row.from,
      replyTo: row.replyTo,
    });

    row.status = 'Sent';
    row.sentAt = new Date();
    row.lastAttemptAt = row.sentAt;
    row.messageId = info.messageId || (info.mocked ? 'mocked' : undefined);
    row.lastError = undefined;
    row.attempts = (row.attempts || 0) + 1;
    await row.save();

    await mirrorToRelated(row, { sent: true });
  } catch (err) {
    row.attempts = (row.attempts || 0) + 1;
    row.lastError = err.message || String(err);
    row.lastAttemptAt = new Date();
    if (row.attempts >= (row.maxAttempts || 6)) {
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
  // Add other related types here as new modules use the outbox
}

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

function startWorker() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tick().catch((e) => console.error('[emailWorker] tick error:', e.message));
  }, POLL_INTERVAL_MS);
  // Drain anything queued during downtime
  tick().catch((e) => console.error('[emailWorker] initial tick error:', e.message));
  console.log(`[emailWorker] started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
}

function stopWorker() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startWorker, stopWorker, tick, processOne };
