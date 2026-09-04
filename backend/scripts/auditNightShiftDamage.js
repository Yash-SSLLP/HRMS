/**
 * READ-ONLY audit: what has the missing night-shift support already cost?
 *
 * Before shifts were honoured, an employee working a shift that crossed midnight
 * hit two faults, every single night:
 *
 *   1. THEY COULD NOT PUNCH OUT. checkOut looked for a record dated TODAY, but a
 *      shift starting 19:00 on the 5th is a record dated the 5th, and its close
 *      falls on the 6th. The punch-out found nothing and was refused with "No
 *      check-in found for today", so the day stayed open.
 *   2. THE AUTO-CLOSE WORKER THEN SETTLED IT. Waking hourly, it picked the record
 *      up just after midnight — while the employee was still at their desk —
 *      measured the day to an assumed 7:00 PM close that had already passed,
 *      arrived at zero hours, and wrote status 'HalfDay'.
 *
 * Payroll charges half a day of loss of pay for each of those (paidDays subtracts
 * 0.5 per HalfDay), and separately counts the night as a LATE arrival, because a
 * 19:10 check-in measured against a 10:00 AM start is 550 minutes late. Past the
 * monthly allowance each of those carries a rupee penalty.
 *
 * This script WRITES NOTHING. It reports who was affected, in which months, and
 * what it appears to have cost, so the correction can be a decision rather than
 * an assumption. Correcting the records is a separate script, deliberately: a
 * re-judgement of settled months changes pay and should not be a side effect of
 * asking how bad it is.
 *
 * Run (from backend/):
 *   node scripts/auditNightShiftDamage.js
 *   node scripts/auditNightShiftDamage.js --from 2026-04-01 --to 2026-09-30
 *
 * HOW A NIGHT IS IDENTIFIED. Historic records carry no shift snapshot — that is
 * the whole point of the fix being forward-only — so a night is inferred from the
 * punch itself: a check-in at or after EVENING_FROM_HOUR on a day that was
 * settled as HalfDay or Absent with `noPunchOut` set. That is the exact fingerprint
 * the two faults leave. It is a heuristic and it is stated as one: a genuine
 * evening mis-punch looks the same, which is why the output lists every affected
 * record rather than only a total.
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the Atlas SRV lookup fails on some networks.
const connectDB = require('../config/db');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const { lateMinutes, effectiveHours } = require('../utils/workday');

// A check-in at or after this hour, on a day that was never closed, is the
// signature of a night shift rather than a short evening day.
const EVENING_FROM_HOUR = 17;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const istHour = (d) => Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false,
}).format(new Date(d)));

const monthKey = (d) => new Date(d).toISOString().slice(0, 7);
const fmtDate = (d) => new Date(d).toISOString().slice(0, 10);

async function main() {
  await connectDB();

  const filter = {
    checkIn: { $ne: null },
    // Both faults leave the day unclosed and downgraded. A night that somehow
    // closed properly cost nothing and is not this script's business.
    status: { $in: ['HalfDay', 'Absent'] },
  };
  const from = arg('from');
  const to = arg('to');
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(`${from}T00:00:00+05:30`);
    if (to) filter.date.$lte = new Date(`${to}T00:00:00+05:30`);
  }

  const records = await Attendance.find(filter)
    .select('employee date status checkIn checkOut noPunchOut hoursWorked remarks')
    .sort({ date: 1 })
    .lean();

  const affected = records.filter((r) => istHour(r.checkIn) >= EVENING_FROM_HOUR && !r.checkOut);
  if (!affected.length) {
    console.log('\nNo affected records found. Either no night shift has been worked in this '
      + 'window, or those nights closed normally.\n');
    return;
  }

  const profiles = await EmployeeProfile.find({ _id: { $in: affected.map((r) => r.employee) } })
    .select('employeeCode user')
    .populate('user', 'firstName lastName')
    .lean();
  const byId = new Map(profiles.map((p) => [String(p._id), p]));

  // person -> month -> tally
  const people = new Map();
  for (const r of affected) {
    const id = String(r.employee);
    if (!people.has(id)) people.set(id, new Map());
    const months = people.get(id);
    const mk = monthKey(r.date);
    if (!months.has(mk)) months.set(mk, { halfDays: 0, absents: 0, lateNights: 0, rows: [] });
    const m = months.get(mk);
    if (r.status === 'HalfDay') m.halfDays += 1;
    if (r.status === 'Absent') m.absents += 1;
    // The late count payroll actually charged: the same function it uses, on the
    // same unstamped record, so this is the real figure and not a re-derivation.
    if (lateMinutes(r) > 0) m.lateNights += 1;
    m.rows.push(r);
  }

  let totalLopDays = 0;
  let totalLateNights = 0;
  let totalNights = 0;

  console.log('\n=================================================================');
  console.log(' NIGHT-SHIFT DAMAGE AUDIT  (read-only — nothing was written)');
  console.log('=================================================================');

  for (const [id, months] of people) {
    const p = byId.get(id);
    const who = p
      ? `${`${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || 'Unknown'}${p.employeeCode ? ` (${p.employeeCode})` : ''}`
      : `profile ${id}`;
    console.log(`\n${who}`);
    for (const [mk, m] of [...months].sort()) {
      const lop = 0.5 * m.halfDays + m.absents;
      totalLopDays += lop;
      totalLateNights += m.lateNights;
      totalNights += m.rows.length;
      console.log(`  ${mk}  nights ${String(m.rows.length).padStart(2)}`
        + `  half-days ${String(m.halfDays).padStart(2)}`
        + `  absent ${String(m.absents).padStart(2)}`
        + `  → ${lop.toFixed(1)} day(s) LOP`
        + `  · counted late on ${m.lateNights} of them`);
      for (const r of m.rows) {
        const hrs = effectiveHours(r);
        console.log(`      ${fmtDate(r.date)}  in ${new Date(r.checkIn).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })}`
          + `  no punch-out  measured ${hrs}h  → ${r.status}`
          + `  late ${lateMinutes(r)}m`);
      }
    }
  }

  console.log('\n-----------------------------------------------------------------');
  console.log(` Employees affected : ${people.size}`);
  console.log(` Nights affected    : ${totalNights}`);
  console.log(` Loss-of-pay days   : ${totalLopDays.toFixed(1)}`);
  console.log(` Nights counted late: ${totalLateNights}   (each one past the monthly`);
  console.log('                        allowance carries the late penalty)');
  console.log('-----------------------------------------------------------------');
  console.log('\nThese are the days the two faults produced. Correcting them is a separate,');
  console.log('deliberate step — a month already Approved would drop back to Draft on its');
  console.log('next payroll run, and a month already Paid needs a manual adjustment.\n');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
