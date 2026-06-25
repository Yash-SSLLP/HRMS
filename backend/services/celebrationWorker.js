/**
 * Daily celebration & holiday digest.
 *
 * Once a day (after SEND_HOUR_IST) this scans for:
 *   - birthdays today          → notify everyone + the birthday person
 *   - work anniversaries today → notify everyone + the celebrant
 *   - holidays today           → notify everyone
 *
 * Each kind is guarded by a DigestLog row keyed on (date, kind) so it fires
 * at most once per day even across restarts or overlapping ticks.
 *
 * New events/holidays created by HR push instantly via their controllers; this
 * worker covers the recurring, date-driven occasions that have no "create" hook.
 */
const EmployeeProfile = require('../models/EmployeeProfile');
const Holiday = require('../models/Holiday');
const User = require('../models/User');
const DigestLog = require('../models/DigestLog');
const { notify, notifyMany } = require('./notify');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const SEND_HOUR_IST = 8; // 8 AM IST
const IST_TZ = 'Asia/Kolkata';

let intervalHandle = null;
let ticking = false;

// 'YYYY-MM-DD' for `date` in IST.
function istDateString(date = new Date()) {
  // en-CA gives ISO-like YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(date);
}

// Current hour (0-23) in IST.
function istHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: IST_TZ, hour: '2-digit', hour12: false }).format(date)
  );
}

function monthDay(d) {
  const x = new Date(d);
  return { m: x.getMonth() + 1, d: x.getDate() };
}

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
  console.log(`Celebration digest: ${people.length} birthday(s) notified.`);
}

async function runAnniversaries(dateStr, today, profiles, everyone) {
  const year = new Date().getFullYear();
  const people = profiles
    .filter((p) => p.dateOfJoining && monthDay(p.dateOfJoining).m === today.m && monthDay(p.dateOfJoining).d === today.d)
    .map((p) => ({ p, years: year - new Date(p.dateOfJoining).getFullYear() }))
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
  console.log(`Celebration digest: ${people.length} anniversary(ies) notified.`);
}

async function runHolidays(dateStr, everyone) {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(`${dateStr}T23:59:59+05:30`);
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
  console.log(`Celebration digest: ${holidays.length} holiday(s) notified.`);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (istHour() < SEND_HOUR_IST) return; // too early in the day
    const dateStr = istDateString();
    const today = monthDay(new Date(`${dateStr}T12:00:00+05:30`));

    const [profiles, everyone] = await Promise.all([activeProfiles(), allActiveUserIds()]);

    await runBirthdays(dateStr, today, profiles, everyone);
    await runAnniversaries(dateStr, today, profiles, everyone);
    await runHolidays(dateStr, everyone);
  } catch (err) {
    console.error('Celebration worker tick failed:', err.message);
  } finally {
    ticking = false;
  }
}

function startWorker() {
  if (intervalHandle) return;
  // Run shortly after boot, then on a fixed interval.
  setTimeout(tick, 10_000).unref?.();
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  intervalHandle.unref?.();
  console.log('Celebration digest worker started.');
}

module.exports = { startWorker, tick };
