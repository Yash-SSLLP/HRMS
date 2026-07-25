/**
 * Daily morning digest — everything on today's calendar, sent once at
 * SEND_HOUR_IST (8 AM IST). One pass per kind:
 *   - birthdays today          → notify everyone + the birthday person
 *   - work anniversaries today → notify everyone + the celebrant
 *   - holidays today           → notify everyone
 *   - company events today     → notify everyone
 *   - reminders dated today     → notify the reminder's own audience (+ its creator)
 *   - interviews today          → notify the assigned interviewer
 *   - task deadlines today      → notify the assignee (open tasks only)
 *
 * Each kind is guarded by a DigestLog row keyed on (date, kind) so it fires
 * at most once per day even across restarts or overlapping ticks.
 *
 * Events/holidays/reminders created by HR also push instantly from their
 * controllers; that is the "it was just created" notice, while this worker is the
 * morning-of nudge for whatever falls on today.
 */
const EmployeeProfile = require('../models/EmployeeProfile');
const Holiday = require('../models/Holiday');
const Event = require('../models/Event');
const Reminder = require('../models/Reminder');
const Candidate = require('../models/Candidate');
const Task = require('../models/Task');
const User = require('../models/User');
const DigestLog = require('../models/DigestLog');
const { notify, notifyMany } = require('./notify');
const { resolveRecipients } = require('../controllers/reminderController');

const { IST_TZ, istMonthDay, istParts, istDateString, istDayRange } = require('../utils/istDate');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const SEND_HOUR_IST = 8; // 8 AM IST

let intervalHandle = null;
let ticking = false;

// Current hour (0-23) in IST.
function istHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: IST_TZ, hour: '2-digit', hour12: false }).format(date)
  );
}

// Recurring occasions must be matched on their IST calendar day — server-local
// month/day is wrong wherever the server isn't in IST (see utils/istDate).
const monthDay = istMonthDay;

// Claim today's digest for `kind`; returns false if already claimed.
async function claim(kind, dateStr) {
  try {
    await DigestLog.create({ date: dateStr, kind });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // unique violation → already sent
    throw err;
  }
}

async function activeProfiles() {
  const profiles = await EmployeeProfile.find({
    $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }],
  }).populate({ path: 'user', select: 'firstName lastName isActive' });
  return profiles.filter((p) => p.user && p.user.isActive !== false);
}

async function allActiveUserIds() {
  const users = await User.find({ isActive: true }).select('_id').lean();
  return users.map((u) => u._id);
}

async function runBirthdays(dateStr, today, profiles, everyone) {
  const people = profiles.filter(
    (p) => p.dateOfBirth && monthDay(p.dateOfBirth).m === today.m && monthDay(p.dateOfBirth).d === today.d
  );
  if (!people.length) return;
  if (!(await claim('birthday', dateStr))) return;

  for (const p of people) {
    const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim();
    // Everyone except the birthday person.
    const others = everyone.filter((id) => String(id) !== String(p.user._id));
    await notifyMany(others, {
      type: 'birthday',
      title: `🎂 It's ${name}'s birthday today!`,
      body: 'Send them your wishes.',
      link: 'celebrations',
    });
    // The birthday person.
    await notify({
      recipient: p.user._id,
      type: 'birthday',
      title: `🎂 Happy Birthday, ${p.user.firstName || 'there'}!`,
      body: 'Wishing you a wonderful day from all of us.',
      link: 'celebrations',
    });
  }
  console.log(`Morning digest: ${people.length} birthday(s) notified.`);
}

async function runAnniversaries(dateStr, today, profiles, everyone) {
  const year = istParts(new Date()).y;
  const people = profiles
    .filter((p) => p.dateOfJoining && monthDay(p.dateOfJoining).m === today.m && monthDay(p.dateOfJoining).d === today.d)
    .map((p) => ({ p, years: year - istParts(p.dateOfJoining).y }))
    .filter((x) => x.years >= 1);
  if (!people.length) return;
  if (!(await claim('anniversary', dateStr))) return;

  for (const { p, years } of people) {
    const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim();
    const others = everyone.filter((id) => String(id) !== String(p.user._id));
    await notifyMany(others, {
      type: 'anniversary',
      title: `🎊 ${name} celebrates ${years} year${years > 1 ? 's' : ''} today!`,
      body: 'Congratulate them on their work anniversary.',
      link: 'celebrations',
    });
    await notify({
      recipient: p.user._id,
      type: 'anniversary',
      title: `🎊 Happy ${years}-year Work Anniversary, ${p.user.firstName || 'there'}!`,
      body: 'Thank you for everything you do.',
      link: 'celebrations',
    });
  }
  console.log(`Morning digest: ${people.length} anniversary(ies) notified.`);
}

async function runHolidays(dateStr, everyone) {
  const [start, end] = istDayRange(dateStr);
  const holidays = await Holiday.find({ date: { $gte: start, $lte: end } });
  if (!holidays.length) return;
  if (!(await claim('holiday', dateStr))) return;

  for (const h of holidays) {
    await notifyMany(everyone, {
      type: 'holiday',
      title: `🎉 Holiday today: ${h.name}`,
      body: h.description || `Enjoy your ${h.type} holiday.`,
      link: 'calendar',
    });
  }
  console.log(`Morning digest: ${holidays.length} holiday(s) notified.`);
}

async function runEvents(dateStr, everyone) {
  const [start, end] = istDayRange(dateStr);
  const events = await Event.find({ date: { $gte: start, $lte: end } });
  if (!events.length) return;
  if (!(await claim('event', dateStr))) return;

  for (const ev of events) {
    const detail = [ev.time, ev.location].filter(Boolean).join(' · ');
    await notifyMany(everyone, {
      type: 'event',
      title: `📅 Today: ${ev.title}`,
      body: detail || ev.description || 'Happening today.',
      link: 'calendar',
    });
  }
  console.log(`Morning digest: ${events.length} event(s) notified.`);
}

/**
 * Reminders dated today → notify each reminder's own audience plus its creator.
 * Audience resolution is reused from the reminder controller so the morning nudge
 * reaches exactly the people the reminder was aimed at.
 */
async function runReminders(dateStr, activeIds) {
  const [start, end] = istDayRange(dateStr);
  const reminders = await Reminder.find({ date: { $gte: start, $lte: end } })
    .populate('createdBy', 'firstName lastName');
  if (!reminders.length) return;
  if (!(await claim('reminder', dateStr))) return;

  const active = new Set(activeIds.map(String));
  let sent = 0;
  for (const r of reminders) {
    const audience = await resolveRecipients(r); // excludes the creator
    const creatorId = String(r.createdBy?._id || r.createdBy);
    const ids = [...new Set([creatorId, ...audience])].filter((id) => active.has(id));
    if (!ids.length) continue;

    const who = `${r.createdBy?.firstName || ''} ${r.createdBy?.lastName || ''}`.trim();
    const bits = [
      r.time ? `at ${r.time}` : null,
      r.scope !== 'self' && who ? `set by ${who}` : null,
      r.priority === 'High' ? 'High priority' : null,
      r.notes || null,
    ].filter(Boolean);
    await notifyMany(ids, {
      type: 'reminder',
      // Personal item — visible in both portals for dual-role users.
      audience: 'all',
      title: `⏰ Reminder today: ${r.title}`,
      body: bits.join(' · ').slice(0, 300) || 'Due today.',
      link: 'calendar',
    });
    sent += ids.length;
  }
  console.log(`Morning digest: ${reminders.length} reminder(s) → ${sent} recipient(s).`);
}

/** Interviews scheduled today → nudge the assigned interviewer. */
async function runInterviews(dateStr, activeIds) {
  const [start, end] = istDayRange(dateStr);
  const candidates = await Candidate.find({ 'rounds.scheduledAt': { $gte: start, $lte: end } })
    .populate('job', 'title')
    .select('name job rounds');

  const active = new Set(activeIds.map(String));
  const items = [];
  for (const c of candidates) {
    for (const r of c.rounds || []) {
      if (!r.scheduledAt || !r.interviewer) continue;
      // Already-decided rounds don't need a nudge.
      if (r.status === 'Cleared' || r.status === 'Rejected') continue;
      const at = new Date(r.scheduledAt);
      if (at < start || at > end) continue;
      if (!active.has(String(r.interviewer))) continue;
      items.push({ c, r, at });
    }
  }
  if (!items.length) return;
  if (!(await claim('interview', dateStr))) return;

  for (const { c, r, at } of items) {
    const time = at.toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST_TZ,
    });
    await notify({
      recipient: r.interviewer,
      type: 'interview',
      audience: 'all',
      title: `🗓 Interview today: ${c.name}`,
      body: [time, r.label, c.job?.title].filter(Boolean).join(' · '),
      link: 'calendar',
    });
  }
  console.log(`Morning digest: ${items.length} interview(s) notified.`);
}

/** Open tasks due today → nudge the assignee. */
async function runTaskDeadlines(dateStr, activeIds) {
  const [start, end] = istDayRange(dateStr);
  const tasks = await Task.find({
    dueDate: { $gte: start, $lte: end },
    status: { $ne: 'Done' },
    assignedTo: { $ne: null },
  }).populate('project', 'name');
  if (!tasks.length) return;
  if (!(await claim('task', dateStr))) return;

  const active = new Set(activeIds.map(String));
  let sent = 0;
  for (const t of tasks) {
    if (!active.has(String(t.assignedTo))) continue;
    const bits = [
      t.project?.name || null,
      t.priority && t.priority !== 'Medium' ? `${t.priority} priority` : null,
      t.status !== 'Todo' ? t.status : null,
    ].filter(Boolean);
    await notify({
      recipient: t.assignedTo,
      type: 'task',
      audience: 'all',
      title: `⏳ Task due today: ${t.title}`,
      body: bits.join(' · ') || 'Due today.',
      link: '/employee/tasks',
    });
    sent += 1;
  }
  console.log(`Morning digest: ${sent} task deadline(s) notified.`);
}

/**
 * One digest pass: if it's past SEND_HOUR_IST, notify everything dated today —
 * birthdays, anniversaries, holidays, company events, reminders, interviews and
 * task deadlines. Re-entrancy guarded by the module `ticking` flag and per-kind
 * DigestLog claims, so overlapping ticks and restarts don't re-send. Each pass is
 * isolated: one failing kind (e.g. a bad reminder row) must not silence the rest.
 * @returns {Promise<void>}
 * @sideEffects Reads profiles/users/holidays/events/reminders/candidates/tasks;
 *   writes DigestLog rows; sends in-app + push notifications.
 */
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (istHour() < SEND_HOUR_IST) return; // too early in the day
    const dateStr = istDateString();
    const today = monthDay(new Date(`${dateStr}T12:00:00+05:30`));

    const [profiles, everyone] = await Promise.all([activeProfiles(), allActiveUserIds()]);

    const passes = [
      ['birthday', () => runBirthdays(dateStr, today, profiles, everyone)],
      ['anniversary', () => runAnniversaries(dateStr, today, profiles, everyone)],
      ['holiday', () => runHolidays(dateStr, everyone)],
      ['event', () => runEvents(dateStr, everyone)],
      ['reminder', () => runReminders(dateStr, everyone)],
      ['interview', () => runInterviews(dateStr, everyone)],
      ['task', () => runTaskDeadlines(dateStr, everyone)],
    ];
    for (const [kind, run] of passes) {
      try {
        await run();
      } catch (err) {
        console.error(`Morning digest (${kind}) failed:`, err.message);
      }
    }
  } catch (err) {
    console.error('Morning digest tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

/**
 * Start the digest worker: an initial catch-up tick ~10s after boot, then every
 * POLL_INTERVAL_MS. No-op if already started. Timers are unref'd so they don't
 * keep the process alive.
 * @returns {void}
 */
function startWorker() {
  if (intervalHandle) return;
  // Run shortly after boot, then on a fixed interval.
  setTimeout(tick, 10_000).unref?.();
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  intervalHandle.unref?.();
  console.log('Morning digest worker started.');
}

module.exports = { startWorker, tick };
