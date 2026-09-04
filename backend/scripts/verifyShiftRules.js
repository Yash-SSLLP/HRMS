/**
 * Offline assertions for the shift rules. Touches NO database — every model is
 * stubbed — so it is safe to run anywhere, any time.
 *
 * It exists because the day-bucketing rule is the one piece of this feature that
 * cannot be checked by reading it: "a punch at 00:20 belongs to yesterday" is
 * either right or it silently creates a duplicate record and leaves a night
 * unclosed for the auto-close worker to charge half a day for. The cases below
 * are the ones that were reasoned about when the rule was written; keeping them
 * runnable is what stops a later tidy-up from quietly reverting it.
 *
 * The two guarantees worth most are negative ones: a DAY-shift employee and an
 * employee with NO shift must bucket exactly as they did before shifts existed.
 *
 * Run (from backend/):
 *   node scripts/verifyShiftRules.js
 */
const path = require('path');
const BE = path.join(__dirname, '..');

const NIGHT = { _id: 'night', name: 'Night Shift', startTime: '19:00', endTime: '04:00' };
const DAY = { _id: 'day', name: 'Day Shift', startTime: '10:00', endTime: '19:00' };

let ROSTER = [];            // [{employee, dateMs, shift}]
let OPEN_RECORDS = [];      // attendance docs

// --- stub the models before shiftResolver requires them ---
const stub = (rel, impl) => { require.cache[require.resolve(path.join(BE, rel))] = { id: rel, filename: rel, loaded: true, exports: impl }; };

stub('models/RosterEntry.js', {
  findOne: (q) => ({ populate: () => ({ lean: async () => {
    const hit = ROSTER.find((r) => String(r.employee) === String(q.employee)
      && new Date(r.dateMs).getTime() === new Date(q.date).getTime());
    return hit ? { shift: hit.shift } : null;
  } }) }),
});
stub('models/Shift.js', { findById: async () => null });
stub('models/Attendance.js', {
  findOne: (q) => ({ sort: () => {
    const rows = OPEN_RECORDS.filter((r) => String(r.employee) === String(q.employee)
      && r.checkIn && !r.checkOut && r.shiftCrossesMidnight === true
      && new Date(r.date) >= q.date.$gte && new Date(r.date) < q.date.$lt);
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    return Promise.resolve(rows[0] || null);
  } }),
});

const { resolveShiftDay, openShiftRecord } = require(path.join(BE, 'services/shiftResolver'));

const ist = (s) => new Date(`${s}+05:30`);
// IST midnight is 18:30 UTC the previous day, so toISOString() would report
// the wrong date. Format in IST, the way the app stores and reads these.
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));

let fail = 0;
const t = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `   got ${got} want ${want}`}`);
};

(async () => {
  const nightProfile = { _id: 'p1', user: 'u1', shiftRef: NIGHT };
  const dayProfile = { _id: 'p2', user: 'u2', shiftRef: DAY };
  const noShift = { _id: 'p3', user: 'u3', shiftRef: null };

  console.log('--- which day does a punch belong to? (Night 19:00-04:00) ---');
  t('18:45 on the 5th (early) -> 5th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-05T18:45'))).day), '2026-09-05');
  t('19:10 on the 5th -> 5th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-05T19:10'))).day), '2026-09-05');
  t('23:50 on the 5th -> 5th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-05T23:50'))).day), '2026-09-05');
  t('00:20 on the 6th (late for the 5th) -> 5th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-06T00:20'))).day), '2026-09-05');
  t('03:55 on the 6th -> 5th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-06T03:55'))).day), '2026-09-05');
  t('07:00 on the 6th (inside carry grace) -> 5th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-06T07:00'))).day), '2026-09-05');
  t('09:00 on the 6th (past grace) -> 6th', ymd((await resolveShiftDay(nightProfile, ist('2026-09-06T09:00'))).day), '2026-09-06');

  console.log('--- day shift and no-shift must be unchanged (always today) ---');
  t('day shift 09:55 -> same day', ymd((await resolveShiftDay(dayProfile, ist('2026-09-06T09:55'))).day), '2026-09-06');
  t('day shift 00:30 -> same day', ymd((await resolveShiftDay(dayProfile, ist('2026-09-06T00:30'))).day), '2026-09-06');
  t('no shift 00:30 -> same day', ymd((await resolveShiftDay(noShift, ist('2026-09-06T00:30'))).day), '2026-09-06');
  t('no shift resolves no shift', (await resolveShiftDay(noShift, ist('2026-09-06T10:00'))).shift, null);

  console.log('--- a roster entry overrides the standing shift for that day ---');
  ROSTER = [{ employee: 'u2', dateMs: ist('2026-09-06T00:00').getTime(), shift: NIGHT }];
  t('day-shift person rostered to nights, 19:30 -> 6th', ymd((await resolveShiftDay(dayProfile, ist('2026-09-06T19:30'))).day), '2026-09-06');
  t('...and resolves the Night Shift', (await resolveShiftDay(dayProfile, ist('2026-09-06T19:30'))).shift.name, 'Night Shift');
  ROSTER = [{ employee: 'u2', dateMs: ist('2026-09-05T00:00').getTime(), shift: NIGHT }];
  t('rostered night on the 5th, punching 00:20 on the 6th -> 5th', ymd((await resolveShiftDay(dayProfile, ist('2026-09-06T00:20'))).day), '2026-09-05');
  ROSTER = [];

  console.log('--- punch-out finds the open overnight shift ---');
  OPEN_RECORDS = [{
    _id: 'a1', employee: 'p1', date: ist('2026-09-05T00:00'),
    checkIn: ist('2026-09-05T19:10'), checkOut: null,
    shiftCrossesMidnight: true, shiftStart: '19:00', shiftDurationMin: 540,
  }];
  t('04:05 on the 6th finds the 5th record', (await openShiftRecord('p1', ist('2026-09-06T04:05')))?._id, 'a1');
  t('07:30 on the 6th (in grace) still finds it', (await openShiftRecord('p1', ist('2026-09-06T07:30')))?._id, 'a1');
  t('09:00 on the 6th (past grace) finds nothing', (await openShiftRecord('p1', ist('2026-09-06T09:00'))), null);

  console.log('--- a day-shift record is never claimed as an open overnight shift ---');
  OPEN_RECORDS = [{
    _id: 'a2', employee: 'p2', date: ist('2026-09-05T00:00'),
    checkIn: ist('2026-09-05T10:00'), checkOut: null,
    shiftCrossesMidnight: false, shiftStart: '10:00', shiftDurationMin: 540,
  }];
  t('unclosed day-shift record is not picked up', (await openShiftRecord('p2', ist('2026-09-06T04:05'))), null);

  console.log(fail ? `\n${fail} FAILED` : '\nall assertions passed');
  process.exitCode = fail ? 1 : 0;
})();
