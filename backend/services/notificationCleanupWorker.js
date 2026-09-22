/**
 * Notification retention — the sweep that stops the feed growing forever.
 *
 * Three things stop being needed, and each stops for a different reason:
 *
 *   READ, and read more than RETAIN_DAYS ago
 *       The rule the company asked for (2026-09-22): an alert you have read is
 *       a thing you have dealt with, and a week is long enough to go back to it.
 *       Counted from `readAt`, NOT `createdAt` — a notification that sat unread
 *       for a month and was opened this morning is one day old as far as this is
 *       concerned, and deleting it tonight would take it away from somebody who
 *       has only just seen it.
 *
 *   PAST ITS OWN expiresAt
 *       The field already means "not worth showing after this" — a celebration
 *       wish sets it two days after the occasion. Those rows are invisible
 *       everywhere already; keeping them is keeping rows nothing will ever read.
 *
 *   SWIPED AWAY, more than RETAIN_DAYS ago
 *       `deletedAt` is somebody saying "I do not want this". It is soft so the
 *       row survives a mistaken swipe, and the same week that covers a read
 *       alert covers a regretted one.
 *
 * DELIBERATELY NOT UNREAD ONES, however old. Nobody has seen them, and the
 * oldest unread in this database is a month old — which is an argument for
 * chasing them, not for deleting them behind the recipient's back.
 *
 * WHAT THIS DESTROYS. A Notification is the only record of a celebration wish:
 * `thankedAt` (so a wish cannot be thanked twice) and `wishFor` hang off it and
 * live nowhere else. After a week a wish is unreachable in every screen anyway
 * — the dashboard card expires after two days and both wishing windows have
 * closed — so nothing breaks, but the history goes. Flagged rather than
 * special-cased: a retention rule with quiet exceptions is a rule nobody can
 * predict. Exclude them here if that turns out to be wrong.
 *
 * Idempotent and cheap: one deleteMany against a few thousand rows, once a day.
 */
const Notification = require('../models/Notification');

/** How long a dealt-with notification is kept. One week, by decision. */
const RETAIN_DAYS = Number(process.env.NOTIFICATION_RETAIN_DAYS) || 7;

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete every notification that is no longer needed.
 *
 * @returns {Promise<{read: number, expired: number, discarded: number}>} what went
 */
async function tick() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RETAIN_DAYS * DAY_MS);

  try {
    // One pass, three reasons. `$or` rather than three round trips: they
    // overlap (a swiped alert is usually also a read one) and a single
    // deleteMany cannot count the same document twice.
    const result = await Notification.deleteMany({
      $or: [
        { readAt: { $ne: null, $lt: cutoff } },
        { expiresAt: { $ne: null, $lt: now } },
        { deletedAt: { $ne: null, $lt: cutoff } },
      ],
    });

    const gone = result.deletedCount || 0;
    // Silent when there was nothing to do — a daily line saying "0" in the logs
    // for the rest of the year teaches everybody to ignore this worker.
    if (gone) console.log(`Notification cleanup: removed ${gone} (read/expired/discarded before ${cutoff.toISOString().slice(0, 10)})`);
    return gone;
  } catch (err) {
    // Never throw: this runs on a timer with nobody watching, and a failed
    // tidy-up must not take the process down. Tomorrow's tick picks up the
    // same rows.
    console.error('Notification cleanup failed:', err.message);
    return 0;
  }
}

/**
 * Start the retention sweep: one tick a few minutes after boot, then daily.
 *
 * The boot tick is DELAYED rather than immediate — a restart during the morning
 * rush should be serving requests, not running a deleteMany over the whole
 * collection. Five minutes is past the point where anything is still warming up.
 * @returns {void}
 */
function startWorker() {
  setTimeout(tick, 5 * 60_000);
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`Notification cleanup worker started (daily, keeping ${RETAIN_DAYS} days)`);
}

module.exports = { startWorker, tick, RETAIN_DAYS };
