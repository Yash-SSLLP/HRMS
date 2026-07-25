/**
 * READ-ONLY diagnostic: why is a birthday / work anniversary missing from the
 * month calendar?
 *
 *   node scripts/diagnoseCelebrations.js            # current IST month
 *   node scripts/diagnoseCelebrations.js 7 2026     # a specific month/year
 *
 * Runs the same queries as celebrationsController.monthCalendar and prints where
 * profiles drop out, so you can tell a data problem (no date of birth recorded,
 * profile has an exit date, linked user deactivated) from a code problem. Makes
 * no writes and starts no workers.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Holiday = require('../models/Holiday');
const Event = require('../models/Event');
const { hiddenUserIds } = require('../utils/visibility');
const { istParts, istMonthDay, istMonthRange, istDateString } = require('../utils/istDate');

const nowIst = istParts(new Date());
const MONTH = Number(process.argv[2] || nowIst.m);
const YEAR = Number(process.argv[3] || nowIst.y);

const name = (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode || '(unnamed)';

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — run this from the backend folder.');
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`\nServer timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}  ·  today in IST: ${istDateString()}`);
  console.log(`Reporting for ${MONTH}/${YEAR}\n`);

  // ---- 1. Is the data there at all? ----
  const totals = {
    profiles: await EmployeeProfile.countDocuments({}),
    withDateOfBirth: await EmployeeProfile.countDocuments({ dateOfBirth: { $exists: true, $ne: null } }),
    withDateOfJoining: await EmployeeProfile.countDocuments({ dateOfJoining: { $exists: true, $ne: null } }),
    withExitDate: await EmployeeProfile.countDocuments({ dateOfExit: { $exists: true, $ne: null } }),
    users: await User.countDocuments({}),
    activeUsers: await User.countDocuments({ isActive: true }),
  };
  console.log('Totals:', totals);
  if (totals.withDateOfBirth === 0) {
    console.log('\n>>> No profile has a date of birth recorded. That alone explains missing birthdays.');
  }

  // ---- 2. Reproduce loadActiveProfiles() as a non-SuperAdmin viewer ----
  const hidden = await hiddenUserIds({ role: 'HRManager' });
  const filter = { $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }] };
  if (hidden.length) filter.user = { $nin: hidden };
  const raw = await EmployeeProfile.find(filter).populate({ path: 'user', select: 'firstName lastName isActive' });
  const visible = raw.filter((p) => p.user && p.user.isActive !== false);

  console.log('\nWho the calendar considers:', {
    superAdminsHiddenFromNonSuperAdmins: hidden.length,
    passedExitDateFilter: raw.length,
    afterDroppingMissingOrInactiveUsers: visible.length,
    droppedHere: raw.length - visible.length,
  });
  const dropped = raw.filter((p) => !(p.user && p.user.isActive !== false));
  if (dropped.length) {
    console.log('Dropped (no linked user, or user deactivated):');
    dropped.slice(0, 20).forEach((p) => console.log(`  · ${p.employeeCode || p._id} — user=${p.user ? 'inactive' : 'MISSING'}`));
  }

  // ---- 3. What lands in the requested month ----
  const bdays = [];
  const annis = [];
  for (const p of visible) {
    if (p.dateOfBirth) {
      const x = istMonthDay(p.dateOfBirth);
      if (x.m === MONTH) bdays.push({ who: name(p), day: x.d, stored: new Date(p.dateOfBirth).toISOString() });
    }
    if (p.dateOfJoining) {
      const j = istParts(p.dateOfJoining);
      const years = YEAR - j.y;
      if (j.m === MONTH) {
        annis.push({ who: name(p), day: j.d, years, shown: years >= 1, stored: new Date(p.dateOfJoining).toISOString() });
      }
    }
  }
  console.log(`\nBirthdays the calendar should show in ${MONTH}/${YEAR}: ${bdays.length}`);
  bdays.sort((a, b) => a.day - b.day).forEach((b) => console.log(`  ${String(b.day).padStart(2)} — ${b.who}   [${b.stored}]`));
  console.log(`\nWork anniversaries in ${MONTH}/${YEAR}: ${annis.filter((a) => a.shown).length} shown, ${annis.filter((a) => !a.shown).length} hidden (<1 year)`);
  annis.sort((a, b) => a.day - b.day).forEach((a) => console.log(`  ${String(a.day).padStart(2)} — ${a.who} (${a.years} yr)${a.shown ? '' : '  <-- hidden, joined under a year ago'}   [${a.stored}]`));

  // ---- 4. Spread across the year, to spot a data-entry gap ----
  const dob = {}; const doj = {};
  visible.forEach((p) => {
    if (p.dateOfBirth) { const m = istMonthDay(p.dateOfBirth).m; dob[m] = (dob[m] || 0) + 1; }
    if (p.dateOfJoining) { const m = istMonthDay(p.dateOfJoining).m; doj[m] = (doj[m] || 0) + 1; }
  });
  console.log('\nBirthdays per month: ', dob);
  console.log('Joinings per month:  ', doj);

  // ---- 5. Holidays / events in the same window ----
  const [start, end] = istMonthRange(YEAR, MONTH);
  const hol = await Holiday.find({ date: { $gte: start, $lt: end } }).select('name date');
  const evs = await Event.find({ date: { $gte: start, $lt: end } }).select('title date');
  console.log(`\nIST month window: ${start.toISOString()} .. ${end.toISOString()}`);
  console.log(`Holidays: ${hol.length}`, hol.map((h) => `${istParts(h.date).d} ${h.name}`));
  console.log(`Events:   ${evs.length}`, evs.map((e) => `${istParts(e.date).d} ${e.title}`));

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('\nDiagnostic failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
