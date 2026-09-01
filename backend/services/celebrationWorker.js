/**
 * Daily morning digest — everything on today's calendar, sent once at
 * SEND_HOUR_IST (8 AM IST). One pass per kind:
 *   - birthdays today          → notify everyone + the birthday person
 *   - work anniversaries today → notify everyone + the celebrant
 *   - wedding anniversaries today → notify everyone + the celebrant
 *   - the same three for CEO/MD → their dates live on the User doc, not a
 *     profile, so they need their own passes (see runExecOccasion)
 *   - company foundation day   → notify everyone in that company
 *   - holidays today           → notify everyone
 *   - festivals today and tomorrow → notify everyone (reminder only, not a day off)
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
const Company = require('../models/Company');
const DigestLog = require('../models/DigestLog');
const { notify, notifyMany } = require('./notify');
const { festivalsInRange, festivalMessage } = require('../utils/festivalFeed');
const { scopeRecipientsToCompany } = require('./audience');
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
    // Everyone in the celebrant's company except the birthday person — the
    // same wall the celebrations API enforces, or the push names somebody the
    // recipient's portal will refuse to show.
    const others = await scopeRecipientsToCompany(
      everyone.filter((id) => String(id) !== String(p.user._id)), p.company
    );
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
    // Company-walled like the birthday pass above.
    const others = await scopeRecipientsToCompany(
      everyone.filter((id) => String(id) !== String(p.user._id)), p.company
    );
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

// Wedding anniversaries. Same shape and the same >= 1 year rule as the work
// anniversary above (the wedding day itself is not an anniversary), but its own
// DigestLog kind so one of the two failing never suppresses the other.
async function runMarriageAnniversaries(dateStr, today, profiles, everyone) {
  const year = istParts(new Date()).y;
  const people = profiles
    .filter((p) => p.dateOfMarriage
      && monthDay(p.dateOfMarriage).m === today.m
      && monthDay(p.dateOfMarriage).d === today.d)
    .map((p) => ({ p, years: year - istParts(p.dateOfMarriage).y }))
    .filter((x) => x.years >= 1);
  if (!people.length) return;
  if (!(await claim('marriage', dateStr))) return;

  for (const { p, years } of people) {
    const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim();
    // Company-walled like the birthday pass above.
    const others = await scopeRecipientsToCompany(
      everyone.filter((id) => String(id) !== String(p.user._id)), p.company
    );
    await notifyMany(others, {
      type: 'marriage',
      title: `💍 ${name} celebrates ${years} year${years > 1 ? 's' : ''} of marriage today!`,
      body: 'Send them your wishes.',
      link: 'celebrations',
    });
    await notify({
      recipient: p.user._id,
      type: 'marriage',
      title: `💍 Happy ${years}-year Wedding Anniversary, ${p.user.firstName || 'there'}!`,
      body: 'Wishing you both many more happy years.',
      link: 'celebrations',
    });
  }
  console.log(`Morning digest: ${people.length} wedding anniversary(ies) notified.`);
}

/**
 * Everyone who should hear about an executive's celebration.
 *
 * An exec is not placed in a company by a profile — `User.companies` is the
 * only thing that places them, and an EMPTY list means every company (the same
 * semantics the read paths use). So: no list → the whole company; a list → the
 * union of the walls for each company they hold.
 * @param {Array} everyone - all active user ids
 * @param {Object} exec - the CEO/MD User doc
 * @returns {Promise<Array>} recipient ids, the exec themselves removed
 */
async function execAudience(everyone, exec) {
  const others = everyone.filter((id) => String(id) !== String(exec._id));
  const companies = (Array.isArray(exec.companies) ? exec.companies : []).filter(Boolean);
  if (!companies.length) return others;
  const seen = new Set();
  const out = [];
  for (const cid of companies) {
    // eslint-disable-next-line no-await-in-loop
    for (const id of await scopeRecipientsToCompany(others, cid)) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      out.push(id);
    }
  }
  return out;
}

// The three executive occasions, in the one shape they differ by. Kept beside
// the staff passes rather than folded into them because the source is a
// different collection and the DigestLog kind must stay separate: an exec pass
// failing must never eat the day's staff birthdays.
const EXEC_OCCASIONS = {
  birthday: {
    kind: 'exec-birthday', field: 'dateOfBirth', needsYears: false, type: 'birthday',
    toEveryone: ({ name }) => ({ title: `🎂 It's ${name}'s birthday today!`, body: 'Send them your wishes.' }),
    toCelebrant: ({ first }) => ({ title: `🎂 Happy Birthday, ${first}!`, body: 'Wishing you a wonderful day from all of us.' }),
  },
  anniversary: {
    kind: 'exec-anniversary', field: 'dateOfJoining', needsYears: true, type: 'anniversary',
    toEveryone: ({ name, years }) => ({ title: `🎊 ${name} celebrates ${years} year${years > 1 ? 's' : ''} today!`, body: 'Congratulate them on their work anniversary.' }),
    toCelebrant: ({ first, years }) => ({ title: `🎊 Happy ${years}-year Work Anniversary, ${first}!`, body: 'Thank you for everything you do.' }),
  },
  marriage: {
    kind: 'exec-marriage', field: 'dateOfMarriage', needsYears: true, type: 'marriage',
    toEveryone: ({ name, years }) => ({ title: `💍 ${name} celebrates ${years} year${years > 1 ? 's' : ''} of marriage today!`, body: 'Send them your wishes.' }),
    toCelebrant: ({ first, years }) => ({ title: `💍 Happy ${years}-year Wedding Anniversary, ${first}!`, body: 'Wishing you both many more happy years.' }),
  },
};

/**
 * One executive occasion (birthday / work anniversary / wedding anniversary).
 * Mirrors the staff passes above, but reads CEO/MD dates off the User document
 * — execs have no EmployeeProfile, which is why they were silently missing
 * from the digest entirely.
 * @param {string} occasion - a key of EXEC_OCCASIONS
 */
async function runExecOccasion(occasion, dateStr, today, everyone) {
  const spec = EXEC_OCCASIONS[occasion];
  const year = istParts(new Date()).y;
  const execs = await User.find({
    role: { $in: ['CEO', 'MD'] },
    isActive: { $ne: false },
    [spec.field]: { $ne: null },
  }).select(`firstName lastName role companies ${spec.field}`).lean();

  const people = execs
    .filter((u) => monthDay(u[spec.field]).m === today.m && monthDay(u[spec.field]).d === today.d)
    .map((u) => ({ u, years: year - istParts(u[spec.field]).y }))
    .filter((x) => !spec.needsYears || x.years >= 1);
  if (!people.length) return;
  if (!(await claim(spec.kind, dateStr))) return;

  for (const { u, years } of people) {
    const name = `${u.firstName || ''} ${u.lastName || ''}`.trim();
    const first = u.firstName || 'there';
    // eslint-disable-next-line no-await-in-loop
    await notifyMany(await execAudience(everyone, u), {
      type: spec.type, ...spec.toEveryone({ name, years }), link: 'celebrations',
    });
    // eslint-disable-next-line no-await-in-loop
    await notify({
      recipient: u._id, type: spec.type, ...spec.toCelebrant({ first, years }), link: 'celebrations',
    });
  }
  console.log(`Morning digest: ${people.length} executive ${occasion}(s) notified.`);
}

/**
 * The company's own foundation day — one occasion the whole company shares, so
 * there is no "celebrant" to notify separately, only everybody in it. The
 * founding year itself is skipped: a company is not 0 years old.
 */
async function runCompanyAnniversaries(dateStr, today, everyone) {
  const year = istParts(new Date()).y;
  const companies = (await Company.find({ foundedOn: { $ne: null }, isActive: { $ne: false } })
    .select('name foundedOn').lean())
    .filter((c) => monthDay(c.foundedOn).m === today.m && monthDay(c.foundedOn).d === today.d)
    .map((c) => ({ c, years: year - istParts(c.foundedOn).y }))
    .filter((x) => x.years >= 1);
  if (!companies.length) return;
  if (!(await claim('company-anniversary', dateStr))) return;

  for (const { c, years } of companies) {
    // eslint-disable-next-line no-await-in-loop
    await notifyMany(await scopeRecipientsToCompany(everyone, c._id), {
      type: 'company',
      title: `🏢 ${c.name} turns ${years} today!`,
      body: `Happy ${years}-year anniversary to everyone at ${c.name}.`,
      link: 'celebrations',
    });
  }
  console.log(`Morning digest: ${companies.length} company anniversary(ies) notified.`);
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

/**
 * Festival reminders — Holi, Diwali, Raksha Bandhan and friends. Purely
 * informational: these are NOT holidays and say nothing about time off (see
 * models/Festival.js). Two nudges per festival, each with its own DigestLog
 * kind so the eve notice and the day-of greeting can't cancel each other:
 *   - 'festival-eve' on the day before  → "Tomorrow is Diwali"
 *   - 'festival'     on the day itself  → "Diwali is today"
 * A festival that shares its day with a company holiday is dropped by
 * festivalsInRange — the holiday pass above already announced that day.
 */
async function runFestivals(dateStr, everyone, when) {
  // The eve pass runs today but looks at tomorrow's festivals.
  const targetStr = when === 'eve'
    ? istDateString(new Date(new Date(`${dateStr}T12:00:00+05:30`).getTime() + 86400000))
    : dateStr;
  const [start, end] = istDayRange(targetStr);
  const festivals = (await festivalsInRange(start, end, { endExclusive: false }))
    .filter((f) => f.notify !== false);
  if (!festivals.length) return;

  // Claimed on today's date so each pass fires once per day, whichever day it reads.
  if (!(await claim(when === 'eve' ? 'festival-eve' : 'festival', dateStr))) return;

  for (const f of festivals) {
    const { title, body } = festivalMessage(f, when);
    await notifyMany(everyone, {
      type: 'festival',
      // Personal, non-work content — visible in both portals for dual-role users.
      audience: 'all',
      title,
      body,
      link: 'calendar',
    });
  }
  console.log(`Morning digest: ${festivals.length} festival(s) notified (${when}).`);
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
      ['marriage', () => runMarriageAnniversaries(dateStr, today, profiles, everyone)],
      ['exec-birthday', () => runExecOccasion('birthday', dateStr, today, everyone)],
      ['exec-anniversary', () => runExecOccasion('anniversary', dateStr, today, everyone)],
      ['exec-marriage', () => runExecOccasion('marriage', dateStr, today, everyone)],
      ['company-anniversary', () => runCompanyAnniversaries(dateStr, today, everyone)],
      ['holiday', () => runHolidays(dateStr, everyone)],
      ['festival', () => runFestivals(dateStr, everyone, 'today')],
      ['festival-eve', () => runFestivals(dateStr, everyone, 'eve')],
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
