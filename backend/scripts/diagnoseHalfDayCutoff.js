/**
 * READ-ONLY diagnostic: which past attendance days break the half-day cut-off
 * rule (a half day declared, but the employee checked in after 12:00 PM IST)?
 *
 *   node scripts/diagnoseHalfDayCutoff.js          # every record ever
 *   node scripts/diagnoseHalfDayCutoff.js 2026     # a single year
 *
 * The rule (utils/workday.js: halfDayCutoffPassed) only started being enforced at
 * punch time on 2026-08-06, so days punched before that were recorded as HalfDay
 * — paid at 0.5 — and were also counted as late arrivals. This lists them, per
 * employee and per month, with the pay difference each one represents, so the
 * impact can be judged before anything is changed.
 *
 * It also reports any day carrying a NON_WORKING status alongside a check-in,
 * since those used to report a late arrival too.
 *
 * Makes NO writes and starts no workers.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const { halfDayCutoffPassed, lateMinutes, NON_WORKING_STATUSES, HALF_DAY_CUTOFF_HOUR } = require('../utils/workday');

const YEAR = process.argv[2] ? Number(process.argv[2]) : null;

const ist = (d, opts) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
const day = (d) => ist(d, { day: '2-digit', month: 'short', year: 'numeric' });
const time = (d) => (d
  ? ist(d, { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\b([ap])\.?\s?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`)
  : '--');

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — run this from the backend folder.');
  await mongoose.connect(process.env.MONGO_URI);

  const filter = { checkIn: { $ne: null } };
  if (YEAR) {
    filter.date = {
      $gte: new Date(`${YEAR}-01-01T00:00:00+05:30`),
      $lt: new Date(`${YEAR + 1}-01-01T00:00:00+05:30`),
    };
  }

  const records = await Attendance.find(filter).sort({ date: 1 }).lean();

  // Resolve employee names once.
  const ids = [...new Set(records.map((r) => String(r.employee)))];
  const profiles = await EmployeeProfile.find({ _id: { $in: ids } })
    .select('employeeCode user')
    .populate('user', 'firstName lastName')
    .lean();
  const nameOf = new Map(profiles.map((p) => [
    String(p._id),
    `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode || String(p._id),
  ]));

  // A. Half day declared, but checked in after the cut-off.
  const breaches = records.filter((r) => r.halfDayDeclared && halfDayCutoffPassed(r));
  // B. Non-working status that still carries a punch (used to show a late arrival).
  const staleLate = records.filter((r) => NON_WORKING_STATUSES.has(r.status) && lateMinutes({ ...r, status: 'Present' }) > 0);

  console.log(`Scanned ${records.length} attendance record(s) with a check-in${YEAR ? ` in ${YEAR}` : ''}.`);
  console.log(`Cut-off: a half day must start by ${HALF_DAY_CUTOFF_HOUR}:00 IST.\n`);

  console.log(`A. Half day declared but checked in after the cut-off: ${breaches.length}`);
  if (breaches.length) {
    const byMonth = new Map();
    for (const r of breaches) {
      const key = ist(r.date, { year: 'numeric', month: 'short' });
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(r);
      console.log(
        `   ${day(r.date)}  ${String(nameOf.get(String(r.employee))).padEnd(22)}`
        + ` in ${time(r.checkIn).padStart(8)}  out ${time(r.checkOut).padStart(8)}`
        + `  status=${String(r.status).padEnd(8)}`
        + `  late=${lateMinutes(r)}m`
      );
    }
    console.log('\n   Per month (each day moves HalfDay 0.5 LOP → Absent 1.0 LOP, i.e. +0.5 day unpaid):');
    for (const [m, rs] of byMonth) {
      console.log(`     ${m}: ${rs.length} day(s) → +${(rs.length * 0.5).toFixed(1)} LOP day(s) across ${new Set(rs.map((r) => String(r.employee))).size} employee(s)`);
    }
  }

  console.log(`\nB. Non-working status with a punch (would have shown a late arrival): ${staleLate.length}`);
  for (const r of staleLate.slice(0, 20)) {
    console.log(`   ${day(r.date)}  ${String(nameOf.get(String(r.employee))).padEnd(22)} status=${r.status} in ${time(r.checkIn)}`);
  }

  console.log('\nNo changes were made — this script only reads.');
  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
