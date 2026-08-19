/**
 * Keeps utils/workday.js's cached late-marking policy in step with the Setting
 * singleton.
 *
 * lateMinutes() is called from synchronous list/report/payroll code, so it reads
 * a module-level cache rather than awaiting the database per record. Something
 * has to fill that cache: this does, once at boot and then on a slow poll.
 *
 * The poll is what makes the setting safe on more than one process — the API
 * that saved it pushes the change in immediately (see attendanceController's
 * updateSettings), but a second web instance, and the background workers, only
 * learn about it on their next refresh. A late-marking rule is not time
 * critical, so a few minutes of skew is fine; silently running last week's rule
 * forever would not be.
 *
 * A failed read leaves whatever is already cached in place — a database hiccup
 * must not reset the company to the 10:00 AM default mid-day.
 */

const Setting = require('../models/Setting');
const { setLatePolicy, getLatePolicy } = require('../utils/workday');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let intervalHandle = null;

/**
 * Re-read the late-marking policy from settings into the process cache.
 * @returns {Promise<{hour: number, minute: number, graceMinutes: number}>} the policy now in force
 */
async function refreshLatePolicy() {
  try {
    const s = await Setting.getSettings();
    return setLatePolicy(s.latePolicy);
  } catch (err) {
    console.error('late policy refresh failed, keeping the cached one:', err.message);
    return getLatePolicy();
  }
}

/**
 * Load the policy now and keep it refreshed. Safe to call once at boot.
 * @returns {void}
 */
function startWorker() {
  if (intervalHandle) return;
  refreshLatePolicy().then((p) => {
    console.log(
      `Late-marking policy loaded: after ${String(p.hour).padStart(2, '0')}:`
      + `${String(p.minute).padStart(2, '0')} IST`
      + (p.graceMinutes ? ` + ${p.graceMinutes} min grace` : ' (no grace window)')
    );
  });
  intervalHandle = setInterval(refreshLatePolicy, REFRESH_INTERVAL_MS);
  if (intervalHandle.unref) intervalHandle.unref();
}

module.exports = { startWorker, refreshLatePolicy };
