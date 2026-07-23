// Notice-period auto-inactivation worker.
//
// Once an accepted resignation (status 'InClearance') passes its last working
// day, the login should be released — BUT only after HR completes every
// clearance formality (IT assets, access, settlement, …). So each tick:
//   • all clearance items done → finalizeExit() (deactivate + Completed) + tell HR
//   • formalities still pending → hold the account and nudge HR once/day
//
// Idempotent: Completed exits fall out of the query, and the daily nudge is
// deduped by `clearanceNudgeYmd` so restarts don't spam. Same lightweight
// interval-tick pattern as the other workers (attendanceWorker/celebrationWorker).
const ExitRequest = require('../models/ExitRequest');
const User = require('../models/User');
const { finalizeExit } = require('../controllers/exitController');
const { notify } = require('./notify');
const { startOfDayIST, ymdIST } = require('../utils/dateHelpers');

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

// Every clearance box that must be ticked before an account is released. Kept in
// sync with clearanceSchema in models/ExitRequest.js.
const CLEARANCE_KEYS = [
  'itAssetsReturned',
  'accessRevoked',
  'knowledgeTransferDone',
  'finalSettlementDone',
  'documentsHandedOver',
];

function clearanceComplete(clearance) {
  const c = clearance || {};
  return CLEARANCE_KEYS.every((k) => !!c[k]);
}

const fmtD = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';

// HR owner for an exit: handledBy → employee's hrPartner → a SuperAdmin.
async function resolveHrRecipient(exit) {
  if (exit.handledBy) return exit.handledBy;
  if (exit.employee?.hrPartner) return exit.employee.hrPartner;
  const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
  return sa?._id || null;
}

/**
 * One pass over accepted exits whose last working day has passed: release the
 * login via finalizeExit() when every clearance item is done, otherwise hold the
 * account and nudge HR at most once per IST day (deduped by clearanceNudgeYmd).
 * @returns {Promise<void>}
 * @sideEffects Reads/updates ExitRequest; may deactivate the user (finalizeExit) and send notifications.
 */
async function tick() {
  try {
    const todayIST = startOfDayIST(new Date());
    // Accepted exits whose notice period has already ended.
    const due = await ExitRequest.find({
      status: 'InClearance',
      lastWorkingDay: { $lt: todayIST },
    }).populate({ path: 'employee', populate: { path: 'user' } });

    let released = 0;
    for (const exit of due) {
      if (!exit.employee) continue; // orphaned profile — skip defensively
      const u = exit.employee.user;
      const name = `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'An employee';

      if (clearanceComplete(exit.clearance)) {
        // Formalities done → release the login.
        await finalizeExit(exit);
        released += 1;
        const hrId = await resolveHrRecipient(exit);
        if (hrId) {
          await notify({
            recipient: hrId,
            type: 'exit',
            audience: 'admin',
            title: 'Exit completed — account released',
            body: `${name}'s notice period ended and clearance is complete. Their login has been deactivated. Send the exit feedback email from the Exit console.`,
            link: '/admin/exits',
          }).catch((err) => console.error('exit release notify failed:', err.message));
        }
      } else {
        // Notice ended but formalities pending — HOLD the account, nudge HR once
        // per IST day until the checklist is finished.
        const today = ymdIST(new Date());
        if (exit.clearanceNudgeYmd === today) continue;
        exit.clearanceNudgeYmd = today;
        await exit.save();
        const hrId = await resolveHrRecipient(exit);
        if (hrId) {
          await notify({
            recipient: hrId,
            type: 'exit',
            audience: 'admin',
            title: 'Clearance pending — account not yet released',
            body: `${name}'s notice period ended on ${fmtD(exit.lastWorkingDay)} but clearance is incomplete. Finish the checklist to release the account.`,
            link: '/admin/exits',
          }).catch((err) => console.error('exit clearance nudge failed:', err.message));
        }
      }
    }
    if (released) console.log(`Exit worker: released ${released} account(s) after notice period`);
  } catch (err) {
    console.error('Exit worker tick failed:', err.message);
  }
}

/**
 * Start the notice-period worker: a catch-up tick ~20s after boot, then every 6h.
 * @returns {void}
 */
function startWorker() {
  setTimeout(tick, 20_000); // catch up shortly after boot
  setInterval(tick, POLL_INTERVAL_MS);
  console.log('Exit notice-period worker started (every 6h)');
}

module.exports = { startWorker, tick };
