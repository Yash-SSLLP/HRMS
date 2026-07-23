// Attendance auto-close worker: once the IST work day is over, any record that
// has a check-in but never got a check-out is stamped `noPunchOut: true` so it
// shows up as "No punch-out" on HR views (and can be fixed via HR edit /
// regularization — filling a check-out clears the flag automatically).
//
// Same lightweight pattern as the other workers: an interval tick that is
// idempotent (the flag itself prevents re-processing), so no DigestLog needed.
const Attendance = require('../models/Attendance');
const { startOfDayIST } = require('../utils/dateHelpers');

const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly

/**
 * One pass: stamp `noPunchOut: true` on every past-day record that has a check-in
 * but no check-out. Idempotent — the flag itself excludes already-processed rows,
 * and filling a check-out later clears it.
 * @returns {Promise<void>}
 * @sideEffects Bulk-updates the Attendance collection.
 */
async function tick() {
  try {
    const todayIST = startOfDayIST(new Date());
    const res = await Attendance.updateMany(
      {
        date: { $lt: todayIST },
        checkIn: { $ne: null },
        checkOut: null,
        noPunchOut: { $ne: true },
      },
      { $set: { noPunchOut: true } }
    );
    if (res.modifiedCount) {
      console.log(`Attendance worker: marked ${res.modifiedCount} record(s) as no punch-out`);
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
