/**
 * One-off backfill: re-settle past attendance against the day-minimum rule.
 *
 * The rule ("a day under N hours is Absent, not a short day") is applied when a
 * day is SETTLED — at punch-out, HR edit, regularization, or by the auto-close
 * worker. Status is never recomputed on read, so turning the rule on, or moving
 * the threshold, leaves every existing record exactly as it was. This walks the
 * back catalogue and applies the same rule to it.
 *
 * Run (from backend/):
 *   node scripts/backfillDayMinimumAbsences.js                      # dry run, writes nothing
 *   node scripts/backfillDayMinimumAbsences.js --year 2026 --month 8
 *   node scripts/backfillDayMinimumAbsences.js --apply --year 2026 --month 8
 *   node scripts/backfillDayMinimumAbsences.js --apply --include-locked
 *
 * THIS CHANGES PAY. Payroll counts `status === 'Absent'` days straight into loss
 * of pay (payrollController computeEmployeeRun), so every row this flips is a day
 * somebody stops being paid for. Read the dry run before you use --apply.
 *
 * WHAT IT WILL NOT TOUCH, and why:
 *   - Any day the live rule declines to judge. It calls the SAME settleStatus()
 *     the app calls, so all four refusals come along for free: no punch-out (the
 *     hours are only assumed, and every evening punch would otherwise qualify), a
 *     declared half day, a Sunday, and a leave day being worked. Nothing is
 *     re-implemented here, so this script cannot drift from the live rule.
 *   - Months whose payroll is already locked — any payslip Approved or Paid, or
 *     released as Finalised. Those figures have been signed off and in most cases
 *     handed to the employee; silently editing the attendance underneath them
 *     desyncs the payslip from its own evidence. Override with --include-locked
 *     only if you intend to re-run payroll for that month afterwards.
 *   - Today and the future. A day still in progress has not been settled yet.
 *
 * Deliberately narrow: writes `status` and appends one `remarks` line, via
 * updateOne so no pre-save hook re-derives anything else. Safe to run twice — a
 * record already carrying the right status is skipped, so a second pass is a
 * no-op.
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const Attendance = require('../models/Attendance');
const Payroll = require('../models/Payroll');
// Required only so populate() can resolve them; never referenced directly.
require('../models/EmployeeProfile');
require('../models/User');
const Setting = require('../models/Setting');
const { settleStatus, setMinPresentHours, getMinPresentHours, effectiveHours } = require('../utils/workday');
const { startOfDayIST, ymdIST, monthRangeIST } = require('../utils/dateHelpers');
// formatDuration, not formatHours: formatHours renders 0 as an empty string
// (a blank cell reads better in a table), and a zero-minute day is precisely the
// finding a reader must not mistake for missing data.
const { formatDuration } = require('../utils/duration');
const dur = (hours) => formatDuration((Number(hours) || 0) * 60);

const APPLY = process.argv.includes('--apply');
const INCLUDE_LOCKED = process.argv.includes('--include-locked');
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : null;
};
const YEAR = argOf('--year');
const MONTH = argOf('--month');

// ymdIST, not getMonth(): attendance dates are IST midnight, which on a UTC host
// is 18:30 the PREVIOUS day — so getMonth() files every 1st-of-the-month record
// under the month before, and the payroll-lock check would then consult the wrong
// month's payslips and happily rewrite days inside a signed-off run.
const monthKey = (d) => ymdIST(d).slice(0, 7);

(async () => {
  await connectDB();

  // The live threshold, not the compiled-in default: running this against the
  // 1h fallback when the company has configured 2h would under-report by half.
  const settings = await Setting.getSettings();
  setMinPresentHours(settings.minPresentHours);
  const minHours = getMinPresentHours();

  if (!minHours) {
    console.log('\nThe day-minimum rule is switched off (minPresentHours = 0). Nothing to backfill.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const today = startOfDayIST(new Date());
  const range = { $lt: today };
  if (YEAR && MONTH) {
    // The same IST boundaries payroll uses. UTC month edges are 5h30m adrift of
    // IST-midnight dates, which silently dropped the 1st of the target month and
    // pulled in the 1st of the next — the script would edit a day in a month the
    // operator never named.
    const { start, end } = monthRangeIST(YEAR, MONTH);
    range.$gte = start;
    range.$lt = end < today ? end : today;
  }

  // Only days that were actually worked can fall under the minimum, and only a
  // completed pair can be measured — the same precondition belowDayMinimum uses.
  const records = await Attendance.find({
    date: range,
    checkIn: { $ne: null },
    checkOut: { $ne: null },
  })
    .populate({ path: 'employee', select: 'employeeCode user', populate: { path: 'user', select: 'firstName lastName' } })
    .sort({ date: 1 })
    .lean();

  console.log(`\nDay minimum in force: ${minHours}h`);
  console.log(`Scanned ${records.length} completed day(s)${YEAR && MONTH ? ` in ${YEAR}-${String(MONTH).padStart(2, '0')}` : ' (all past days)'}.`);

  // ---- Which months are already paid / issued? ----
  const lockedMonths = new Set();
  const payslips = await Payroll.find({
    $or: [{ status: { $in: ['Approved', 'Paid'] } }, { 'release.status': 'Finalised' }],
  }).select('payPeriodYear payPeriodMonth').lean();
  for (const p of payslips) {
    lockedMonths.add(`${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}`);
  }

  // ---- Decide, using the LIVE rule ----
  const hits = [];
  let skippedLocked = 0;
  for (const r of records) {
    // settleStatus reads `record.status`, and the populated lean doc carries it.
    const next = settleStatus(r);
    if (next !== 'Absent' || r.status === 'Absent') continue;
    const mk = monthKey(new Date(r.date));
    if (lockedMonths.has(mk) && !INCLUDE_LOCKED) { skippedLocked += 1; continue; }
    hits.push({ r, mk, hours: effectiveHours(r) });
  }

  if (!hits.length) {
    console.log(`\nNothing to change.${skippedLocked ? ` (${skippedLocked} skipped in locked payroll months — see --include-locked.)` : ''}\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // ---- Report, grouped by person, because the unit of harm is a person ----
  const nameOf = (r) => {
    const u = r.employee && r.employee.user;
    const n = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
    return n || (r.employee && r.employee.employeeCode) || 'unknown';
  };
  const byPerson = new Map();
  for (const h of hits) {
    const key = nameOf(h.r);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(h);
  }

  console.log(`\n${hits.length} day(s) across ${byPerson.size} employee(s) would become Absent:\n`);
  for (const [name, list] of [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${name} — ${list.length} day(s)`);
    for (const h of list.slice(0, 10)) {
      console.log(`      ${ymdIST(h.r.date)}  ${String(h.r.status).padEnd(8)} -> Absent   (${dur(h.hours)})`);
    }
    if (list.length > 10) console.log(`      … and ${list.length - 10} more`);
  }

  const months = [...new Set(hits.map((h) => h.mk))].sort();
  console.log(`\n  Months affected: ${months.join(', ')}`);
  if (skippedLocked) {
    console.log(`  ${skippedLocked} day(s) skipped in months with Approved/Paid/Finalised payroll.`);
    console.log('  Re-run with --include-locked ONLY if you will re-run payroll for those months.');
  }
  if (INCLUDE_LOCKED) {
    const lockedHit = months.filter((m) => lockedMonths.has(m));
    if (lockedHit.length) {
      console.log(`\n  WARNING: --include-locked is set and ${lockedHit.join(', ')} already has signed-off payroll.`);
      console.log('  Payslips already issued will disagree with the attendance behind them until payroll is re-run.');
    }
  }
  console.log(`\n  Each day above becomes loss of pay unless it falls inside that month's 2-day paid-leave quota.`);

  if (!APPLY) {
    console.log('\nDry run — nothing changed. Re-run with --apply to write.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ---- Write ----
  // updateOne, not save(): this must set the status and append one remark and
  // touch nothing else. Attendance has no audit plugin, so the remark IS the
  // record of why a paid day stopped being paid.
  let written = 0;
  for (const h of hits) {
    const note = `Backfill: worked ${dur(h.hours)}, under the ${minHours}h day minimum → marked absent.`;
    const remarks = [h.r.remarks, note].filter(Boolean).join(' · ');
    // eslint-disable-next-line no-await-in-loop
    await Attendance.updateOne({ _id: h.r._id }, { $set: { status: 'Absent', remarks } });
    written += 1;
  }

  console.log(`\n  Updated ${written} record(s).`);
  console.log('  Re-run payroll for the affected months so the payslips match.\n');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
