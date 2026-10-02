/**
 * Training worker (2026-10-02) — what a booked session needs from the clock.
 *
 *   1. STATUS FOLLOWS THE SCHEDULE in the database too: Planned → Ongoing at
 *      the start, → Completed at the end. Requests already read the live answer
 *      (trainingController.liveStatus); this keeps the stored field — which the
 *      app builds already installed display, and the list filter matches —
 *      from lagging behind it. Cancelled and a hand-marked Completed are never
 *      touched: those are decisions, not times.
 *   2. "STARTING SOON" — once, to every participant and the trainer, in the
 *      quarter-hour before the start, with the join link one tap away.
 *   3. "HOW CLEAR WAS IT?" — once, after the session ends, to every participant
 *      who has not already reviewed it. The review form is on My Trainings.
 *
 * Both notices follow the house rules the task reminders were written around:
 *   · ONCE — each is claimed with a conditional update (reminderSentAt /
 *     feedbackAskedAt still empty), so two instances racing a tick cannot both
 *     send it, and a restart cannot replay it.
 *   · NEVER STALE — a notice whose moment passed too long ago is stamped
 *     WITHOUT being sent. A server that was down overnight must not wake up and
 *     deliver yesterday's "starting soon" at breakfast; and on the first run
 *     after this ships, every training already in the past is stamped quietly
 *     rather than asking people to review sessions from last month.
 */
const Training = require('../models/Training');
const { notifyMany } = require('./notify');
const { liveStatus, effectiveEnd, timeText } = require('../controllers/trainingController');

/** How often the sweep runs — a minute, so "starting soon" lands on time. */
const TICK_MS = 60 * 1000;
/** The reminder goes out this long before the start… */
const REMIND_BEFORE_MIN = 15;
/** …and is not worth sending once the session is this far under way. */
const REMIND_LATE_MIN = 5;
/** A review is asked for within this long of the end, or not at all. */
const FEEDBACK_WINDOW_H = 24;
/** A training with no end time is assumed to run this long (as in the controller). */
const DEFAULT_LENGTH_MIN = 60;

const idOf = (v) => String(v?._id || v || '');

/** Pass 1 — move stored statuses on with the clock. */
async function progressStatuses(now) {
  const hourAgo = new Date(now.getTime() - DEFAULT_LENGTH_MIN * 60000);
  await Training.updateMany(
    { status: 'Planned', startDate: { $lte: now }, endDate: { $gt: now } },
    { $set: { status: 'Ongoing' } }
  );
  await Training.updateMany(
    { status: 'Planned', endDate: null, startDate: { $lte: now, $gt: hourAgo } },
    { $set: { status: 'Ongoing' } }
  );
  await Training.updateMany(
    { status: { $in: ['Planned', 'Ongoing'] }, endDate: { $lte: now } },
    { $set: { status: 'Completed' } }
  );
  await Training.updateMany(
    { status: { $in: ['Planned', 'Ongoing'] }, endDate: null, startDate: { $lte: hourAgo } },
    { $set: { status: 'Completed' } }
  );
}

/** Pass 2 — "starting soon", once, inside its window. */
async function sendReminders(now) {
  const soon = new Date(now.getTime() + REMIND_BEFORE_MIN * 60000);
  const lateCut = new Date(now.getTime() - REMIND_LATE_MIN * 60000);
  const due = await Training.find({
    status: { $ne: 'Cancelled' },
    reminderSentAt: null,
    startDate: { $lte: soon, $gte: lateCut },
  }).select('title startDate endDate status completedAt participants trainerUser meetingLink').lean();

  for (const t of due) {
    const claim = await Training.updateOne({ _id: t._id, reminderSentAt: null }, { $set: { reminderSentAt: now } });
    if (!claim.modifiedCount) continue;
    // Marked finished by hand before it began — nothing to turn up to.
    if (liveStatus(t, now.getTime()) === 'Completed') continue;
    const people = [...new Set([...(t.participants || []), t.trainerUser].map(idOf).filter(Boolean))];
    if (!people.length) continue;
    notifyMany(people, {
      type: 'training',
      title: `Starting soon: ${t.title}`,
      body: `Starts at ${timeText(t.startDate)}.${t.meetingLink ? ' Tap to join from My Trainings.' : ' Details are in My Trainings.'}`,
      link: 'trainings',
      action: true,
    }).catch(() => {});
  }

  // Started more than REMIND_LATE_MIN ago and never reminded (the server was
  // down, or the training predates this worker): stamp it, say nothing.
  await Training.updateMany(
    { reminderSentAt: null, startDate: { $lt: lateCut } },
    { $set: { reminderSentAt: now } }
  );
}

/** Pass 3 — ask for reviews, once, soon after the end. */
async function askForFeedback(now) {
  const ended = await Training.find({ status: 'Completed', feedbackAskedAt: null })
    .select('title startDate endDate status completedAt participants feedback.user')
    .lean();
  for (const t of ended) {
    const claim = await Training.updateOne({ _id: t._id, feedbackAskedAt: null }, { $set: { feedbackAskedAt: now } });
    if (!claim.modifiedCount) continue;
    const endedAt = t.completedAt ? new Date(t.completedAt) : effectiveEnd(t);
    if (!endedAt || now.getTime() - endedAt.getTime() > FEEDBACK_WINDOW_H * 3600000) continue;
    const reviewed = new Set((t.feedback || []).map((f) => idOf(f.user)));
    const ask = [...new Set((t.participants || []).map(idOf))].filter((id) => id && !reviewed.has(id));
    if (!ask.length) continue;
    notifyMany(ask, {
      type: 'training',
      title: `How clear was “${t.title}”?`,
      body: 'Rate the training in My Trainings — it takes half a minute and shapes the next session.',
      link: 'trainings',
      action: true,
    }).catch(() => {});
  }
}

/**
 * One sweep. Each pass in its own try, so one bad document cannot silence the
 * others. `now` is injectable for tests.
 * @param {Date} [now]
 */
async function tick(now = new Date()) {
  try { await progressStatuses(now); } catch (err) { console.error('[training-worker] status pass failed:', err.message); }
  try { await sendReminders(now); } catch (err) { console.error('[training-worker] reminder pass failed:', err.message); }
  try { await askForFeedback(now); } catch (err) { console.error('[training-worker] feedback pass failed:', err.message); }
}

/**
 * Start the sweep — first one shortly after boot, then every minute.
 * @returns {void}
 */
function startWorker() {
  setTimeout(() => tick().catch(() => {}), 30 * 1000);
  setInterval(() => tick().catch(() => {}), TICK_MS);
  console.log(`Training worker started (every ${TICK_MS / 1000}s; reminder ${REMIND_BEFORE_MIN} min before, review asked after the end)`);
}

module.exports = { startWorker, tick, REMIND_BEFORE_MIN, FEEDBACK_WINDOW_H };
