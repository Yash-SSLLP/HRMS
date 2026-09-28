/**
 * Notification retention — the sweep that stops the feed growing forever.
 *
 * Three things stop being needed, and each stops for a different reason:
 *
 *   READ, and read more than READ_RETAIN_HOURS ago
 *       An alert you have read is a thing you have dealt with. It was a week
 *       (2026-09-22); the company cut it to 24 HOURS after it is seen
 *       (2026-09-28). Counted from `readAt`, NOT `createdAt` — a notification
 *       that sat unread for a month and was opened this morning is only hours
 *       old as far as this is concerned, and deleting it now would take it away
 *       from somebody who has only just seen it.
 *
 *   PAST ITS OWN expiresAt
 *       The field already means "not worth showing after this" — a celebration
 *       wish sets it two days after the occasion. Those rows are invisible
 *       everywhere already; keeping them is keeping rows nothing will ever read.
 *
 *   SWIPED AWAY, more than SWIPED_RETAIN_DAYS ago
 *       `deletedAt` is somebody saying "I do not want this". It is soft so the
 *       row survives a mistaken swipe; a week covers a regretted one.
 *
 * DELIBERATELY NOT UNREAD ONES, however old. Nobody has seen them, and the
 * oldest unread in this database is a month old — which is an argument for
 * chasing them, not for deleting them behind the recipient's back.
 *
 * CELEBRATION WISHES ARE LEFT TO THEIR OWN expiresAt, even once read. A
 * Notification is the only record of a wish: `thankedAt` (so a wish cannot be
 * thanked twice) and `celebration` (so a colleague cannot wish the same
 * birthday twice) hang off it and live nowhere else. At a week that did not
 * matter — every wishing window had closed by then — but at 24 hours a wish
 * read on the morning of the birthday would be gone the next morning, bringing
 * the sender's Wish button back and taking the recipient's Say-thanks with it.
 * Wishes are the only notifications that set `expiresAt`, so "has no expiresAt"
 * is the test; theirs removes them two days after the occasion.
 *
 * Idempotent and cheap: one deleteMany against a few thousand rows, hourly —
 * hourly so "24 hours after it was seen" is kept to within the hour rather
 * than to within a day.
 */
const Notification = require('../models/Notification');

/** How long a read notification is kept after it was seen. 24 hours, by decision. */
const READ_RETAIN_HOURS = Number(process.env.NOTIFICATION_READ_RETAIN_HOURS) || 24;
/** How long a swiped-away notification is kept, for a regretted swipe. One week. */
const SWIPED_RETAIN_DAYS = Number(process.env.NOTIFICATION_RETAIN_DAYS) || 7;

const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Delete every notification that is no longer needed.
 *
 * @returns {Promise<number>} how many went
 */
async function tick() {
  const now = new Date();
  const readCutoff = new Date(now.getTime() - READ_RETAIN_HOURS * HOUR_MS);
  const swipedCutoff = new Date(now.getTime() - SWIPED_RETAIN_DAYS * DAY_MS);

  try {
    // One pass, three reasons. `$or` rather than three round trips: they
    // overlap (a swiped alert is usually also a read one) and a single
    // deleteMany cannot count the same document twice.
    const result = await Notification.deleteMany({
      $or: [
        // `expiresAt: null` matches a missing field too — i.e. not a wish.
        { readAt: { $ne: null, $lt: readCutoff }, expiresAt: null },
        { expiresAt: { $ne: null, $lt: now } },
        { deletedAt: { $ne: null, $lt: swipedCutoff } },
      ],
    });

    const gone = result.deletedCount || 0;
    // Silent when there was nothing to do — an hourly line saying "0" in the
    // logs for the rest of the year teaches everybody to ignore this worker.
    if (gone) console.log(`Notification cleanup: removed ${gone} (read over ${READ_RETAIN_HOURS}h ago, expired, or swiped away)`);
    return gone;
  } catch (err) {
    // Never throw: this runs on a timer with nobody watching, and a failed
    // tidy-up must not take the process down. The next tick picks up the same
    // rows.
    console.error('Notification cleanup failed:', err.message);
    return 0;
  }
}

/**
 * Start the retention sweep: one tick a few minutes after boot, then hourly.
 *
 * The boot tick is DELAYED rather than immediate — a restart during the morning
 * rush should be serving requests, not running a deleteMany over the whole
 * collection. Five minutes is past the point where anything is still warming up.
 * @returns {void}
 */
function startWorker() {
  setTimeout(tick, 5 * 60_000);
  setInterval(tick, POLL_INTERVAL_MS);
  console.log(`Notification cleanup worker started (hourly; read kept ${READ_RETAIN_HOURS}h, swiped kept ${SWIPED_RETAIN_DAYS} days)`);
}

module.exports = { startWorker, tick, READ_RETAIN_HOURS, SWIPED_RETAIN_DAYS };
