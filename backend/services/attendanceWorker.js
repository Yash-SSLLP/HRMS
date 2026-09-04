// Attendance auto-close worker: once the IST work day is over, any record that
// has a check-in but never got a check-out is stamped `noPunchOut: true` so it
// shows up as "No punch-out" on HR views (and can be fixed via HR edit /
// regularization — filling a check-out clears the flag automatically).
//
// It also settles the day's status. A day is only worth a full day if it ran to
// HALF_DAY_MIN_HOURS; with no punch-out the day is counted from the check-in to
// WORKDAY_END_HOUR (7 PM), so an afternoon arrival that was never closed out
// becomes a half day while a morning one stays a full day. Regularizing the day
// replaces the assumption with the real times and re-derives the status.
//
// Same lightweight pattern as the other workers: an interval tick that is
// idempotent (the flag itself prevents re-processing), so no DigestLog needed.
const Attendance = require('../models/Attendance');
const { startOfDayIST } = require('../utils/dateHelpers');
const { settleStatus, effectiveHours, shiftEndAt } = require('../utils/workday');
const { CARRY_GRACE_MS } = require('../utils/shiftWindow');
const { formatHours } = require('../utils/duration');

const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly

// Spelled out because the remark used to be a two-way ternary that printed
// "Present" for anything that was not 'HalfDay' — which would have written
// "→ Present" onto a record it had just marked Absent.
const STATUS_LABEL = { Present: 'Present', HalfDay: 'Half Day', Absent: 'Absent' };

// When this record was due to end, in words, for the remark. Derived from the
// record's own frozen shift rather than from one org-wide constant: a night
// shift closed at 4 AM, and a remark that says it was counted to 7:00 PM is
// not a rounding error, it is the record explaining itself incorrectly to the
// person disputing it.
const endLabel = (record) => {
  const d = shiftEndAt(record);
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
};

/**
 * One pass over every past-day record that has a check-in but no check-out:
 * stamp `noPunchOut`, and downgrade the day to HalfDay when the assumed hours
 * fall short. Idempotent — the flag excludes already-processed rows, and filling
 * a check-out later clears it.
 *
 * Saves documents one by one rather than updateMany because the status depends
 * on each record's own check-in time, and because the model's pre-save hooks
 * (hoursWorked, noPunchOut clearing) must run.
 * @returns {Promise<void>}
 * @sideEffects Updates Attendance documents.
 */
async function tick() {
  try {
    const todayIST = startOfDayIST(new Date());
    const stale = await Attendance.find({
      date: { $lt: todayIST },
      checkIn: { $ne: null },
      checkOut: null,
      noPunchOut: { $ne: true },
    });

    let closed = 0;
    let downgraded = 0;
    for (const record of stale) {
      // A shift that has not finished yet is not a forgotten punch-out.
      // This worker wakes hourly and picks up anything dated before today, so
      // the first tick after midnight used to catch a night-shift employee who
      // was still at their desk: it stamped noPunchOut, measured the day to an
      // assumed 7 PM close that had already passed, and settled it as a half
      // day - half a day of pay, every night worked.
      //
      // Provably a no-op for a record with no shift: its close works out to
      // 7 PM + 4h = 11 PM on its own day, and the query only sees a record once
      // the day is already over.
      if (Date.now() < shiftEndAt(record).getTime() + CARRY_GRACE_MS) continue;
      record.noPunchOut = true;
      const next = settleStatus(record);
      if (next && next !== record.status) {
        const hours = effectiveHours(record);
        record.status = next;
        record.remarks = [
          record.remarks,
          `No punch-out; counted to ${endLabel(record)} = ${formatHours(hours)} → ${STATUS_LABEL[next] || next}.`,
        ].filter(Boolean).join(' · ');
        downgraded += 1;
      }
      await record.save();
      closed += 1;
    }

    if (closed) {
      console.log(`Attendance worker: marked ${closed} record(s) as no punch-out`
        + (downgraded ? `, ${downgraded} downgraded` : ''));
    }
  } catch (err) {
    console.error('Attendance worker tick failed:', err.message);
  }
}

/**
 * Start the auto-close worker: a catch-up tick ~15s after boot, then hourly.
 * @returns {void}
 */
function startWorker() {
  setTimeout(tick, 15_000); // catch up shortly after boot
  setInterval(tick, POLL_INTERVAL_MS);
  console.log('Attendance auto-close worker started (hourly)');
}

module.exports = { startWorker, tick };
