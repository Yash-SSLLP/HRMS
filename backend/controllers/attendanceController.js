/**
 * Attendance controller — GPS+selfie punch in/out (photo to Cloudinary with local
 * fallback), geofence evaluation (captured, never blocking), and all attendance
 * reporting: personal/org heatmaps, per-day detail, month summary, punch-location
 * map, daily stats, today's clock board, presence board, manual HR record CRUD,
 * Excel export, and office/geofence settings. Every "day" is anchored to the IST
 * calendar day so punches from any client land on the day the user sees. Several
 * helpers (computeHeatmapWindow/computeDayDetails/runAttendanceExport) are shared
 * with the manager controller for team-scoped views.
 */
const asyncHandler = require('express-async-handler');
const path = require('path');
const ExcelJS = require('exceljs');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const Setting = require('../models/Setting');
const storage = require('../services/storage');
const cloudinary = require('../services/cloudinary');
const { haversineMeters } = require('../utils/geo');
const { formatDuration, formatHours } = require('../utils/duration');
const {
  HALF_DAY_CUTOFF_HOUR, getLatePolicy, setLatePolicy, normalizeLatePolicy,
  lateMinutes, statusFromHours, settleStatus, effectiveHours, halfDayCutoffPassed,
  getMinPresentHours, setMinPresentHours, normalizeMinPresentHours,
} = require('../utils/workday');
const { resolveShiftDay, openShiftRecord } = require('../services/shiftResolver');
const { shiftSnapshot, rollForwardIfInverted } = require('../utils/shiftWindow');
// Sunday / org-wide Comp Off days worked → an approvable double-pay claim.
const { COMP_OFF, compOffKeysFor, doublePayState, restDayCredit, isSundayKey } = require('../utils/restDay');
const { notify, notifyMany, notifyBackend } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');
const { hasPermission, isExecViewer } = require('../middleware/authMiddleware');
const { allowedEmployeeIds, scopeEmployeeFilter, cannotManageProfile, employeeProfileScope, assertNotOwnRequest } = require('../utils/employeeScope');
// Punching in on a day you are on approved leave. The leave-side rules (which
// day a leave still claims, who sits at the top of the ladder, and how a day is
// handed back) live in leaveController; this module owns the punch and the
// decision. leaveController requires no controller of its own, so this is a
// one-way dependency.
const {
  leaveCoveringDay, topLeaveApproverFor, releaseLeaveDay, leaveLabel,
} = require('./leaveController');
// All attendance "day" logic is anchored to the IST calendar day so it is
// independent of the server's timezone (the deployed backend runs in UTC).
// This keeps a punch made from any client (mobile or web) on the same IST day
// the user sees, so it surfaces correctly on the website's attendance views.
const { startOfDayIST: startOfDay, monthRangeIST: monthRange, ymdIST: ymdLocal } = require('../utils/dateHelpers');

// Attendance is a record of what HAS happened, so the registers never show
// future dates. This matters because approving a leave stamps an OnLeave/Absent
// row onto EVERY working day it covers, including days still to come — without
// this cap, approving leave for the 14th makes a 14th row appear on the 12th.
// The rows are still written (payroll and reporting need them); they simply stay
// out of the list until their day arrives. Upcoming leave belongs to the leave
// and calendar screens, which show it as a plan rather than as attendance.
// Returns the exclusive upper bound to query with: the earlier of the requested
// range end and the end of today (IST).
function capToToday(end) {
  const tomorrow = startOfDay(new Date());
  tomorrow.setDate(tomorrow.getDate() + 1);
  return end < tomorrow ? end : tomorrow;
}

// Full month names (index 0 = January) for building human-readable export filenames.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Who may look at somebody ELSE's punch selfie. Deliberately the same audience
// the rest of the attendance admin surface is gated on (routes: requirePermission
// 'attendance.manage'), which is wider than SuperAdmin/HRManager: a read-only
// CEO/MD and a Manager holding the grant both see the records in the list, so
// they must be able to open the photos in those rows too. Per-record company /
// hrPartner scoping still applies on top (cannotManageProfile).
function canViewOthersAttendance(user) {
  return isExecViewer(user) || hasPermission(user, 'attendance.manage');
}

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId }).populate('workLocationRef');
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

// ===== Employee =====

// Persist the uploaded selfie. Prefers Cloudinary (durable across redeploys)
// and falls back to local disk when Cloudinary is unconfigured or the upload
// fails. Returns { cloud, path } — exactly one is set.
async function savePunchPhoto(req, profileId) {
  if (!req.file) {
    const err = new Error('A photo is required to punch. Please allow the camera and capture your photo.');
    err.status = 400;
    throw err;
  }
  if (cloudinary.enabled()) {
    try {
      const cloud = await cloudinary.uploadImageBuffer(req.file.buffer, {
        folder: `${process.env.CLOUDINARY_FOLDER || 'hrms-lms'}/attendance/${profileId}`,
      });
      return { cloud };
    } catch (err) {
      // Fall through to local disk so a Cloudinary hiccup never blocks a punch.
      console.error('[attendance] Cloudinary selfie upload failed, using local disk:', err.message);
    }
  }
  const { storagePath } = await storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'attendance',
    ownerId: profileId,
    originalName: req.file.originalname || 'punch.jpg',
  });
  return { path: storagePath };
}

// Parse the GPS location sent with a punch, if present and valid.
function parsePunchLocation(body) {
  const lat = parseFloat(body.latitude);
  const lng = parseFloat(body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  // Out of range is not a location. Now that a punch is REFUSED without one,
  // the difference between "no location" and "a nonsense location" stops being
  // cosmetic — without this, a client sending latitude=999 would satisfy the
  // requirement and store a coordinate the punch map cannot plot.
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  // Exactly 0,0 is in the Gulf of Guinea and is what a failed fix serialises to
  // far more often than anyone is genuinely standing there.
  if (lat === 0 && lng === 0) return undefined;
  const accuracy = parseFloat(body.accuracy);
  return { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : undefined };
}

// The geofence a punch is measured against: the employee's assigned work
// location if they have one, otherwise the global office (Setting.office).
// Returns { center:{lat,lng}, radiusM, label, exempt }.
//
// `exempt` is the per-person grant to punch from anywhere
// (EmployeeProfile.remotePunchAllowed). It is carried HERE rather than checked
// at each call site because "was this punch outside the fence?" is worked out in
// five different places — the punch itself, the month summary, the export, the
// punch map and the manager's team view — and a grant that half of them honoured
// would show the same employee as flagged on one screen and clear on the next.
// Distances are still computed and still shown; only the verdict changes.
function resolveGeofence(profile, settings) {
  const exempt = profile?.remotePunchAllowed === true;
  const wl = profile && profile.workLocationRef;
  if (wl && wl.lat != null && wl.lng != null) {
    return {
      center: { lat: wl.lat, lng: wl.lng },
      radiusM: wl.radiusM != null ? wl.radiusM : settings.geofenceThresholdM,
      label: wl.name || 'work location',
      exempt,
    };
  }
  return {
    center: settings.office,
    radiusM: settings.geofenceThresholdM,
    label: settings.office?.label || 'office',
    exempt,
  };
}

// Apply the geofence rule to a punch against a given center + radius. A punch
// beyond the radius is captured as an out-of-range punch — the punch is never
// blocked. Two things exempt it: the employee declaring that punch as WFH, and
// the standing per-person grant to punch from anywhere (see resolveGeofence).
// `exempt` is either of those, already OR-ed by the caller. Returns the distance
// in metres (or null when no location was captured) so callers can note it.
function evaluateGeofence(loc, exempt, center, radiusM) {
  const distanceM = loc ? haversineMeters(center, loc) : null;
  // Allow the GPS error margin as tolerance so an imprecise fix (common indoors /
  // on laptops) doesn't wrongly flag an in-range punch as "outside". Cap the
  // tolerance at the radius so a wildly inaccurate fix can't mask a genuinely
  // far-away punch.
  const tolerance = loc && loc.accuracy != null ? Math.min(loc.accuracy, radiusM || 0) : 0;
  const outside = Boolean(
    !exempt && radiusM && distanceM != null && distanceM - tolerance > radiusM
  );
  return { distanceM, outside };
}

// Append a note to a record's remarks without dropping any existing text, and
// without duplicating the same note if the punch is retried/edited.
function appendRemark(existing, note) {
  const base = (existing || '').trim();
  if (!base) return note;
  if (base.includes(note)) return base;
  return `${base} ${note}`;
}

// A punch instant as 12-hour IST, e.g. "12:41 PM" — remarks are read by HR and
// the employee, and the portal shows every time of day in 12-hour form.
// Node's en-IN emits a lowercase "pm" where the browser emits "PM"; upper-case it
// so a server-written remark reads like every other time in the UI.
const to12hIst = (d, tz) => new Date(d)
  .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz })
  .replace(/\b([ap])\.?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`);

const fmtIstTime = (d) => (d ? to12hIst(d, 'Asia/Kolkata') : '');

// The cut-off itself, written the same way (e.g. "12:00 PM"), so the remark
// stays correct if HALF_DAY_CUTOFF_HOUR is ever changed.
const HALF_DAY_CUTOFF_LABEL = to12hIst(Date.UTC(2000, 0, 1, HALF_DAY_CUTOFF_HOUR, 0), 'UTC');

// A day written the way the employee reads it, e.g. "14 Aug 2026".
const fmtIstDate = (d) => new Date(d).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

// ===== Working through your own leave =====

/**
 * Open a work-on-leave claim if this punch lands on a day the employee is on
 * approved leave.
 *
 * The punch itself is never refused — the employee may genuinely be needed —
 * but it does not silently convert the day into a worked one either, which is
 * what used to happen: check-in overwrote the OnLeave stamp with 'Present' while
 * the leave stayed spent. Instead the day KEEPS its leave status and the claim
 * goes to the top rung of that employee's leave hierarchy to rule on.
 *
 * Mutates `record` (status + workOnLeave) but does not save it — the caller is
 * mid-punch and saves once.
 *
 * @param {Object} profile - the punching employee's EmployeeProfile
 * @param {Date} day - IST midnight of the punch day
 * @param {Object} record - the Attendance document being written
 * @returns {Promise<Object|null>} the claim sub-document, or null when not on leave
 */
async function openWorkOnLeaveClaim(profile, day, record) {
  // A claim already exists for the day (a second punch, or an HR-reset record) —
  // never reopen it, or a rejected day could be quietly re-queued.
  if (record.workOnLeave && record.workOnLeave.status) return record.workOnLeave;

  const leave = await leaveCoveringDay(profile._id, day);
  if (!leave) return null;

  const top = await topLeaveApproverFor(profile);
  // Nobody at all could be resolved to decide it — not a rung, not the HR
  // partner, not even a SuperAdmin. Holding the day hostage to an approval that
  // no one can ever see would be worse than not raising it, so let the punch
  // behave as an ordinary one rather than stranding the employee's day.
  if (!top?.approver) return null;

  // Whatever the leave auto-stamp wrote is what the day goes back to if this is
  // rejected: OnLeave for a paid day, Absent for an LOP one. A brand-new record
  // (the stamp never ran) is treated as ordinary paid leave.
  const leaveStatus = record.status === 'Absent' ? 'Absent' : 'OnLeave';

  record.workOnLeave = {
    status: 'Pending',
    leaveRequest: leave._id,
    leaveType: leave.leaveType,
    leaveStatus,
    approver: top.approver,
    approverName: top.approverName || '',
    requestedAt: new Date(),
  };
  record.status = leaveStatus;
  return record.workOnLeave;
}

/**
 * In-app + push nudge to the one person who decides a work-on-leave claim, and
 * to the Backend.
 *
 * The Backend notice lives inside this function rather than at the call sites
 * (as it does for leave, exits and regularizations) because a claim is never a
 * ladder — it is raised and routed in one step and never climbs, so there is no
 * repeat notification to guard against.
 */
async function notifyWorkOnLeaveApprover(record, profile, claim) {
  if (!claim?.approver) return;
  try {
    const user = await require('../models/User').findById(profile.user).select('firstName lastName');
    const name = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'An employee';
    await notifyBackend({
      type: 'attendance',
      title: 'Punch-in on a leave day raised',
      body: `${name} punched in on ${fmtIstDate(record.date)} while on approved ${leaveLabel(claim.leaveType)}.`,
      link: 'approvals',
      exclude: [claim.approver, profile.user],
    });
    await notify({
      recipient: claim.approver,
      type: 'attendance',
      // 'all', not 'admin'. The top rung of a leave ladder can be ANY employee —
      // commonly a plain Manager with no admin portal at all — and the
      // notification list is filtered by portal (see notificationController's
      // audienceScope), so an 'admin' notice is invisible to exactly the people
      // most likely to be the approver.
      audience: 'all',
      title: 'Punch-in on a leave day needs your approval',
      body: `${name} punched in on ${fmtIstDate(record.date)} while on approved ${leaveLabel(claim.leaveType)}. Approve to give the leave day back and count the day as worked.`,
      link: 'approvals',
    });
  } catch (err) {
    console.error('work-on-leave approver notify failed:', err.message);
  }
}

/**
 * Tell HR the outcome — the point of the whole flow, since HR is who pays for
 * it: an approval both returns a leave day to the employee's monthly quota and
 * turns an unworked day into a worked one in the payroll run.
 *
 * Resolved by capability (attendance.manage / leave.manage) so the list tracks
 * config/permissions.js rather than a hard-coded role, matching how the leave
 * module picks its HR audience. The decider and the employee are dropped: both
 * already know.
 */
async function notifyHrWorkOnLeave(record, profile, claim, actorId) {
  try {
    const ids = new Set();
    // Walled to the employee's company: HR of another company neither pays for
    // nor should hear about this day.
    const holders = new Set();
    for (const id of await usersHoldingAny('attendance.manage')) holders.add(String(id));
    for (const id of await usersHoldingAny('leave.manage')) holders.add(String(id));
    for (const id of await scopeRecipientsToCompany([...holders], profile.company)) ids.add(String(id));
    if (profile.hrPartner) ids.add(String(profile.hrPartner));
    if (!ids.size) {
      const sa = await require('../models/User')
        .findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
      if (sa) ids.add(String(sa._id));
    }
    if (actorId) ids.delete(String(actorId));
    if (profile.user) ids.delete(String(profile.user));
    if (!ids.size) return;

    const user = await require('../models/User').findById(profile.user).select('firstName lastName');
    const name = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'An employee';
    const approved = claim.status === 'Approved';
    const day = fmtIstDate(record.date);
    await notifyMany([...ids], {
      type: 'attendance',
      audience: 'admin',
      title: approved ? 'Work on a leave day approved' : 'Work on a leave day rejected',
      body: approved
        ? `${name} worked ${day} while on approved ${leaveLabel(claim.leaveType)}. ${claim.decidedByName || 'The approver'} approved it${claim.leaveDayReturned ? ' — the leave day has been returned and the day now counts as worked' : ' — the day now counts as worked'}.`
        : `${name} punched in on ${day} while on approved ${leaveLabel(claim.leaveType)}. ${claim.decidedByName || 'The approver'} rejected it — the day stays as leave and the punches are kept for the record.${claim.note ? ` Note: ${claim.note}` : ''}`,
      link: 'attendance',
    });
  } catch (err) {
    console.error('work-on-leave HR notify failed:', err.message);
  }
}

/**
 * Open claims for days that were punched BEFORE this feature existed.
 *
 * A punch made against the old code overwrote the leave stamp with 'Present'
 * and raised nothing, so those days are invisible to every approver and always
 * would be — nothing re-examines a finished punch. This runs on inbox load (the
 * same self-healing idea as healOrphanChains for leave) over a bounded recent
 * window, so a day worked on leave still reaches its approver after the fact.
 *
 * Deliberately NOT called from countMyApprovals: every signed-in user polls that
 * on a timer, whereas an inbox load is occasional.
 *
 * @returns {Promise<number>} how many claims were opened
 */
async function healWorkOnLeaveClaims() {
  const HEAL_WINDOW_DAYS = 14;
  let opened = 0;
  try {
    const since = new Date(startOfDay(new Date()).getTime() - HEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await Attendance.find({
      date: { $gte: since },
      checkIn: { $ne: null },
      'workOnLeave.status': { $exists: false },
    }).limit(500);

    for (const record of rows) {
      try {
        const profile = await EmployeeProfile.findById(record.employee);
        if (!profile) continue;
        const claim = await openWorkOnLeaveClaim(profile, startOfDay(record.date), record);
        if (!claim) continue;
        record.remarks = appendRemark(
          record.remarks,
          `Punched in while on approved ${leaveLabel(claim.leaveType)} — awaiting approval${claim.approverName ? ` from ${claim.approverName}` : ''}.`
        );
        await record.save();
        await notifyWorkOnLeaveApprover(record, profile, claim);
        opened += 1;
      } catch (err) {
        console.error('heal work-on-leave claim failed:', err.message);
      }
    }
  } catch (err) {
    console.error('healWorkOnLeaveClaims failed:', err.message);
  }
  return opened;
}

/**
 * Work-on-leave claims for one approver's inbox, newest day first.
 *
 * Returned as plain rows rather than raw Attendance documents because the
 * approver needs the person and the leave behind the claim, not the day's photo
 * flags — and because Attendance.toJSON is shaped for the employee's own view.
 *
 * @param {string} userId - the approver
 * @param {'pending'|'history'} scope
 * @returns {Promise<Object[]>}
 */
async function listWorkOnLeaveClaims(userId, scope = 'pending', all = false) {
  await healWorkOnLeaveClaims();
  // `all` is the Backend's everything-view (see approvalController's
  // seesAllApprovals): claims are routed to one named approver, so without it a
  // SuperAdmin's inbox shows only the handful pointed at them.
  const mine = all ? {} : { 'workOnLeave.approver': userId };
  const filter = scope === 'history'
    ? { ...mine, 'workOnLeave.status': { $exists: true, $ne: null } }
    : { ...mine, 'workOnLeave.status': 'Pending' };

  const rows = await Attendance.find(filter)
    .select('employee date checkIn checkOut hoursWorked status remarks workOnLeave')
    .populate({
      path: 'employee',
      select: 'employeeCode designation department user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ date: -1 })
    .limit(200)
    .lean();

  return rows.map((r) => ({
    _id: String(r._id),
    employee: r.employee,
    date: r.date,
    checkIn: r.checkIn || null,
    checkOut: r.checkOut || null,
    hoursWorked: r.hoursWorked || 0,
    status: r.status,
    workOnLeave: r.workOnLeave,
  }));
}

/**
 * Record the decision on one work-on-leave claim.
 *
 * Approve → the leave day is handed back (dropped from the request's paid/LOP
 * split, credited to the maternity bucket if applicable, and freed from the
 * 2-paid-days-a-month count by the status flip) and the day becomes a normal
 * worked day. Reject → the punches stay on the record for audit but the day
 * keeps its leave status and the leave stays spent. HR is told either way.
 *
 * Mutates + saves the record; throws Error with `.status` on a bad transition.
 *
 * @param {Object} record - Attendance document (not lean)
 * @param {string} userId - the deciding user's id
 * @param {'approve'|'reject'} action
 * @param {string} [note]
 * @param {Object} [actor] - the full user, so an HR override can be recognised
 * @returns {Promise<{record: Object, leaveDayReturned: boolean}>}
 */
async function decideWorkOnLeave(record, userId, action, note, actor) {
  const claim = record.workOnLeave;
  if (!claim || !claim.status) {
    const err = new Error('That day has no work-on-leave approval to decide.');
    err.status = 400;
    throw err;
  }
  if (claim.status !== 'Pending') {
    const err = new Error(`Cannot ${action} - this claim is already ${claim.status}.`);
    err.status = 400;
    throw err;
  }
  // The named approver decides. HR keeps an override so a claim is never stuck
  // behind someone who has left or is unavailable — the same safety valve leave
  // itself has (applyLeaveDecision).
  const mine = claim.approver && String(claim.approver) === String(userId);
  if (!mine && !(actor && hasPermission(actor, 'leave.manage'))) {
    const err = new Error('This punch-in is not awaiting your approval.');
    err.status = 403;
    throw err;
  }
  // Neither route may be used on your own day. The named-approver branch can
  // point at the employee when the ladder is empty and their HR Partner is
  // themselves; the HR override branch is wider still, and would otherwise let
  // any HR holding leave.manage approve their own claim and hand themselves the
  // leave day back.
  await assertNotOwnRequest(userId, { profileId: record.employee });

  const now = new Date();
  const approved = action === 'approve';
  const decidedByName = `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim();
  let leaveDayReturned = false;

  if (approved) {
    // Hand the day back BEFORE deciding the status, but never let a failure here
    // lose the decision — the approver acted, and an unreleased day is a
    // reporting discrepancy HR can correct, not a reason to refuse them.
    try {
      const { LeaveRequest } = require('../models/Leave');
      const leave = claim.leaveRequest ? await LeaveRequest.findById(claim.leaveRequest) : null;
      // Which bucket the day came out of is what the auto-stamp wrote on it:
      // OnLeave = a paid day, Absent = an LOP one.
      if (leave) {
        leaveDayReturned = await releaseLeaveDay(
          leave, ymdLocal(record.date), claim.leaveStatus !== 'Absent'
        );
      }
    } catch (err) {
      console.error('releaseLeaveDay failed:', err.message);
    }
  }

  record.workOnLeave = {
    ...(typeof claim.toObject === 'function' ? claim.toObject() : claim),
    status: approved ? 'Approved' : 'Rejected',
    decidedBy: userId,
    decidedAt: now,
    note: note || undefined,
    leaveDayReturned,
  };

  if (approved) {
    // The punch counts from here on, so the ordinary hours rule decides the day.
    // It has to be taken off the leave status first: statusFromHours refuses to
    // judge a non-working day (by design), and would otherwise return null.
    // belowDayMinimum() deliberately exempts a work-on-leave day, so a short
    // approved shift cannot both hand the leave day back AND cost a day's pay.
    record.status = settleStatus(record) || 'Present';
    record.remarks = appendRemark(
      record.remarks,
      `Worked while on ${leaveLabel(claim.leaveType)} — approved${decidedByName ? ` by ${decidedByName}` : ''}${leaveDayReturned ? '; the leave day was returned' : ''}.`
    );
  } else {
    record.status = claim.leaveStatus || 'OnLeave';
    record.remarks = appendRemark(
      record.remarks,
      `Worked while on ${leaveLabel(claim.leaveType)} — not approved${decidedByName ? ` by ${decidedByName}` : ''}; the day stays as leave.`
    );
  }
  await record.save();

  // `company` rides along for the notification wall in notifyHrWorkOnLeave —
  // without it the recipient filter sees undefined and fans out org-wide.
  const profile = await EmployeeProfile.findById(record.employee).select('user hrPartner company').lean();
  const saved = record.workOnLeave;
  const decided = { ...(typeof saved.toObject === 'function' ? saved.toObject() : saved), decidedByName };
  if (profile?.user) {
    await notify({
      recipient: profile.user,
      type: 'attendance',
      audience: 'employee',
      title: approved ? 'Your work on a leave day was approved' : 'Your work on a leave day was not approved',
      body: approved
        ? `${fmtIstDate(record.date)} now counts as a working day${leaveDayReturned ? ', and the leave day has been returned to you' : ''}.${note ? ` Note: ${note}` : ''}`
        : `${fmtIstDate(record.date)} stays recorded as ${leaveLabel(claim.leaveType)}. Your punches are kept on the record.${note ? ` Note: ${note}` : ''}`,
      link: 'attendance',
    }).catch(() => {});
  }
  if (profile) await notifyHrWorkOnLeave(record, profile, decided, userId);

  return { record, leaveDayReturned };
}

/**
 * A self-service punch must carry a location.
 *
 * Throws 400 rather than recording the punch without one. Deliberately checked
 * BEFORE savePunchPhoto at both call sites: the selfie is uploaded to storage,
 * so refusing after it has been saved leaves an orphaned file behind for a punch
 * that never happened.
 *
 * This is the SELF-SERVICE rule only. HR corrections (updateRecord, adminCreate),
 * regularization approvals and imports legitimately have no GPS — somebody typing
 * yesterday's forgotten punch is not standing at the gate — and they do not come
 * through here.
 *
 * The exemptions that already exist (a WFH punch, and the standing "punch
 * anywhere" grant) are about being outside the GEOFENCE, not about withholding
 * coordinates, so they do not exempt anyone from this. Where you are is still
 * recorded; it just is not compared against the fence.
 *
 * @param {object|undefined} loc - the output of parsePunchLocation
 * @param {import('express').Response} res
 * @throws {Error} 400 when there is no usable location
 */
function requirePunchLocation(loc, res) {
  if (loc) return;
  res.status(400);
  throw new Error(
    'Your location is needed to record this punch. Allow location access, '
    + 'make sure location is switched on, and try again.'
  );
}

/**
 * Punch in for today with a selfie and a REQUIRED GPS location (the geofence itself
 * is captured, not blocked — see requirePunchLocation).
 * @route POST /api/attendance/me/checkin  (multipart field: photo)
 * @param {File} req.file - selfie (required)
 * @param {string} req.body.latitude / req.body.longitude - required; 400 without them
 * @param {string} [req.body.accuracy]
 * @param {string} [req.body.wfh] - 'true' exempts the geofence check
 * @param {string} [req.body.halfDay] - 'true' declares the day a half day up front
 * @returns {{record: Object}} (201); 400 if already checked in
 */
// POST /api/attendance/me/checkin   (multipart: photo)
const checkIn = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  // Not simply today: someone on a 19:00-04:00 shift punching in at 00:20 is
  // arriving late for YESTERDAY's shift. Bucketing that under today would open
  // a second record, leave last night unclosed for the auto-close worker to
  // settle from an assumption, and then refuse their real punch tomorrow
  // evening with 'Already checked in today'. For everyone not on a shift that
  // crosses midnight this returns exactly what startOfDay(new Date()) did.
  const { day: today, shift } = await resolveShiftDay(profile, new Date());

  let record = await Attendance.findOne({ employee: profile._id, date: today });
  if (record && record.checkIn) {
    res.status(400);
    throw new Error('Already checked in today');
  }
  // Before the photo: a refusal here must not leave an uploaded selfie behind.
  const loc = parsePunchLocation(req.body);
  requirePunchLocation(loc, res);
  const photo = await savePunchPhoto(req, profile._id);
  if (!record) {
    record = new Attendance({ employee: profile._id, date: today });
  }
  // Freeze the shift onto the day the first time it is punched. Guarded, so a
  // re-punch or a later re-assignment can never move the hours a day that has
  // already been judged was judged under. Stamped here rather than in the
  // Attendance constructor above because the record may already exist without
  // a punch - the leave auto-stamp and an HR pre-created day both do that.
  if (!record.shift) Object.assign(record, shiftSnapshot(shift) || {});
  record.checkIn = new Date();
  record.checkInPhoto = photo.path;
  record.checkInPhotoCloud = photo.cloud;
  record.checkInLocation = loc;
  // A WFH punch is exempt from the geofence check, so the claim is only honoured
  // for employees a SuperAdmin has granted it to — never on the client's word.
  record.checkInWfh = req.body.wfh === 'true' && profile.wfhAllowed === true;
  // Geofence rule: capture (but never block) a punch outside the employee's
  // assigned work location (or the global office if unassigned).
  const settings = await Setting.getSettings();
  const geo = resolveGeofence(profile, settings);
  // Either exemption clears the punch: the employee declaring this one as WFH,
  // or the standing grant to punch from anywhere.
  const { distanceM, outside } = evaluateGeofence(loc, record.checkInWfh || geo.exempt, geo.center, geo.radiusM);
  record.checkInOutsideGeofence = outside;
  if (outside) {
    record.remarks = appendRemark(record.remarks, `Check-in outside ${geo.label} (${distanceM} m).`);
  }
  // An employee can declare a half day up front (planned half day, medical
  // appointment, and so on) instead of waiting until punch-out. The declaration
  // is remembered on the record so the hours rule at punch-out cannot undo it.
  //
  // A half day may be either half of the day, so declaring one after 12:00 PM is
  // a normal afternoon half day and is always honoured. It only changes lateness:
  // the second half doesn't start at 10:00 AM, so lateMinutes() reports 0 for it.
  record.halfDayDeclared = req.body.halfDay === 'true';

  // Punching in on a day you are on approved leave. The punch is kept, but the
  // day stays leave and the claim goes to the top of the leave hierarchy — so
  // this must run before the status is decided, and owns it when it fires.
  const claim = await openWorkOnLeaveClaim(profile, today, record);
  if (!claim) record.status = record.halfDayDeclared ? 'HalfDay' : 'Present';

  if (record.halfDayDeclared && halfDayCutoffPassed(record)) {
    record.remarks = appendRemark(
      record.remarks,
      `Afternoon half day: checked in at ${fmtIstTime(record.checkIn)}, after ${HALF_DAY_CUTOFF_LABEL} — not counted as a late arrival.`
    );
  }
  if (claim && claim.status === 'Pending') {
    record.remarks = appendRemark(
      record.remarks,
      `Punched in while on approved ${leaveLabel(claim.leaveType)} — awaiting approval${claim.approverName ? ` from ${claim.approverName}` : ''}.`
    );
  }
  await record.save();

  if (claim && claim.status === 'Pending') {
    await notifyWorkOnLeaveApprover(record, profile, claim);
  }

  res.status(201).json({
    record,
    // The client turns this into the on-screen warning. Absent on an ordinary punch.
    workOnLeave: claim && claim.status === 'Pending'
      ? {
        status: claim.status,
        leaveType: claim.leaveType,
        approverName: claim.approverName || '',
        message: `You are on approved ${leaveLabel(claim.leaveType)} today. Your punch has been recorded but today still counts as leave until ${claim.approverName || 'your leave approver'} approves it. Once approved, the leave day is returned to you and the day counts as worked.`,
      }
      : null,
  });
});

/**
 * Punch out for today with a selfie and optional GPS; may (re)mark the day half-day.
 * @route POST /api/attendance/me/checkout  (multipart field: photo)
 * @param {File} req.file - selfie (required)
 * @param {string} [req.body.latitude] / [req.body.longitude] / [req.body.accuracy] / [req.body.wfh]
 * @param {string} [req.body.halfDay] - 'true'/'false' to set/clear HalfDay
 * @returns {{record: Object}}; 400 if no check-in or already checked out
 */
// POST /api/attendance/me/checkout   (multipart: photo)
const checkOut = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const today = startOfDay(new Date());

  // An overnight shift's punch-out lands on the NEXT calendar day, so looking
  // only at today's record is why a 19:00-04:00 employee punching out at 04:05
  // was told 'No check-in found for today' and left with an unclosed day the
  // worker then downgraded to a half day. The open-record lookup is filtered on
  // shiftCrossesMidnight, so it can never claim a day-shift record.
  const record = await openShiftRecord(profile._id, new Date())
    || await Attendance.findOne({ employee: profile._id, date: today });
  if (!record || !record.checkIn) {
    res.status(400);
    throw new Error('No check-in found for today');
  }
  if (record.checkOut) {
    res.status(400);
    throw new Error('Already checked out today');
  }
  // Before the photo, for the same reason as check-in: a refusal must not leave
  // an uploaded selfie behind for a punch that was never recorded.
  const loc = parsePunchLocation(req.body);
  requirePunchLocation(loc, res);
  const photo = await savePunchPhoto(req, profile._id);
  record.checkOut = new Date();
  record.checkOutPhoto = photo.path;
  record.checkOutPhotoCloud = photo.cloud;
  record.checkOutLocation = loc;
  // Same grant check as check-in — see the note there.
  record.checkOutWfh = req.body.wfh === 'true' && profile.wfhAllowed === true;
  // Geofence rule: capture (but never block) a punch outside the employee's
  // assigned work location (or the global office if unassigned).
  const settings = await Setting.getSettings();
  const geo = resolveGeofence(profile, settings);
  // Either exemption clears the punch — see check-in.
  const { distanceM, outside } = evaluateGeofence(loc, record.checkOutWfh || geo.exempt, geo.center, geo.radiusM);
  record.checkOutOutsideGeofence = outside;
  if (outside) {
    record.remarks = appendRemark(record.remarks, `Check-out outside ${geo.label} (${distanceM} m).`);
  }
  // An employee can always declare a half day at punch-out. Otherwise the hours
  // decide: under HALF_DAY_MIN_HOURS the day is a half day until regularized.
  // `halfDay=false` deliberately does NOT force 'Present' — the web app sends it
  // on every punch-out, so honouring it would override the rule every time. A
  // declaration made at CHECK-IN stands for the same reason: only a longer form
  // of the same statement, and the hours rule must not talk the employee out of
  // it. HR can still correct the day through a regularization.
  if (req.body.halfDay === 'true') record.halfDayDeclared = true;
  // A day worked on leave holds its leave status until the claim is decided, so
  // punching out must not promote it to a worked day. statusFromHours already
  // refuses to judge a leave day; the half-day declaration is the branch that
  // would otherwise slip past.
  {
    // settleStatus owns the precedence (declaration > day-minimum > half-day >
    // present) so the five places that settle a day cannot drift apart. The
    // undecided-work-on-leave hold that used to be duplicated here now lives in
    // settleStatus too, so the worker and the HR edit get it as well.
    record.status = settleStatus(record) || record.status;
    if (record.status === 'Absent') {
      record.remarks = appendRemark(
        record.remarks,
        `Worked ${formatHours(effectiveHours(record))} — under the ${getMinPresentHours()}h minimum, so the day is marked absent.`
      );
    }
  }
  await record.save();
  res.json({ record });
});

/**
 * Stream a punch selfie (Cloudinary proxied, else local disk).
 * @route GET /api/attendance/:id/photo/:which  (which = checkin | checkout)
 * @param {string} req.params.id - attendance record id
 * @param {string} req.params.which - 'checkin' or 'checkout'
 * @returns {binary}; HR/SuperAdmin or the owning employee only
 */
// GET /api/attendance/:id/photo/:which   (which = checkin | checkout)
// Visible to HR/SuperAdmin or the owning employee. Streams the image inline.
const getAttendancePhoto = asyncHandler(async (req, res) => {
  const { id, which } = req.params;
  if (!['checkin', 'checkout'].includes(which)) {
    res.status(400);
    throw new Error("which must be 'checkin' or 'checkout'");
  }
  const record = await Attendance.findById(id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }

  // Admins only within their scope — HR of company A must not pull company B's
  // punch selfies by record id. The owning employee always may.
  let allowed = false;
  if (canViewOthersAttendance(req.user)) {
    const recProfile = await EmployeeProfile.findById(record.employee).select('hrPartner company').lean();
    allowed = !cannotManageProfile(req, recProfile);
  }
  if (!allowed) {
    const profile = await EmployeeProfile.findOne({ user: req.user._id });
    if (profile && profile._id.equals(record.employee)) allowed = true;
  }
  if (!allowed) {
    res.status(403);
    throw new Error('Not authorized to view this photo');
  }

  // Prefer the durable Cloudinary copy when present. Proxy the bytes through our
  // server (rather than redirecting) so the response stays same-origin for the
  // token-authenticated blob fetch the frontend uses.
  const cloud = which === 'checkin' ? record.checkInPhotoCloud : record.checkOutPhotoCloud;
  if (cloud && cloud.publicId) {
    try {
      const url = cloudinary.imageDeliveryUrl(cloud);
      const upstream = await fetch(url);
      if (!upstream.ok) {
        res.status(404);
        throw new Error('Photo not available');
      }
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      // Fall through to any local copy below before giving up.
      console.error('[attendance] Cloudinary selfie fetch failed:', err.message);
    }
  }

  const relPath = which === 'checkin' ? record.checkInPhoto : record.checkOutPhoto;
  if (!relPath) {
    res.status(404);
    throw new Error('No photo for this punch');
  }

  const ext = path.extname(relPath).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (!(await storage.streamTo(relPath, res))) return res.status(404).json({ message: 'File not found' });
});

/**
 * The caller's day-by-day attendance classification for a heatmap.
 * @route GET /api/attendance/me/heatmap?days=365
 * @param {number} [req.query.days] - trailing window, capped at 400 (default 365)
 * @returns {{from, to, days}} each day categorized full|half|leave|compoff|absent
 */
// GET /api/attendance/me/heatmap?days=365
// Returns the caller's day-by-day attendance classification over the trailing
// window for a GitHub-style heatmap. Each day is one of:
//   full | half | leave | compoff | absent   (days with no record are omitted).
// Combines attendance records, approved leave ranges and availed comp-offs.
// No employee profile (e.g. SuperAdmin) → empty list.
const myHeatmap = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id });
  if (!profile) return res.json({ days: [] });

  const span = Math.min(Number(req.query.days) || 365, 400);
  const end = startOfDay(new Date());
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - (span - 1));

  const { LeaveRequest } = require('../models/Leave');
  const CompOff = require('../models/CompOff');

  const [records, leaves, comps] = await Promise.all([
    Attendance.find({ employee: profile._id, date: { $gte: start, $lte: end } })
      .select('date status checkIn checkOut hoursWorked noPunchOut checkInWfh checkOutWfh remarks halfDayDeclared shift shiftName shiftStart shiftEnd shiftDurationMin shiftCrossesMidnight').lean(),
    LeaveRequest.find({ employee: profile._id, status: 'Approved', startDate: { $lte: end }, endDate: { $gte: start } })
      .select('startDate endDate isHalfDay halfDaySession leaveType').lean(),
    CompOff.find({ employee: req.user._id, status: 'Availed', availedOn: { $gte: start, $lte: end } })
      .select('availedOn').lean(),
  ]);

  const att = {};
  for (const r of records) att[ymdLocal(r.date)] = r;

  const compoffSet = new Set(comps.filter((c) => c.availedOn).map((c) => ymdLocal(c.availedOn)));

  // Track the leave type covering each day so the hover card can show it.
  const leaveByDay = {};
  for (const lv of leaves) {
    const d = startOfDay(new Date(lv.startDate));
    const last = startOfDay(new Date(lv.endDate));
    while (d <= last) {
      if (d >= start && d <= end) {
        leaveByDay[ymdLocal(d)] = {
          type: lv.leaveType,
          half: !!lv.isHalfDay,
          session: lv.halfDaySession || null,
        };
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Classify each day in the window (worked days take priority over leave/absent).
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    const key = ymdLocal(cur);
    const rec = att[key];
    const status = rec?.status;
    const leave = leaveByDay[key];
    let category = null;
    if (status === 'Present') category = 'full';
    else if (status === 'HalfDay') category = 'half';
    else if (compoffSet.has(key)) category = 'compoff';
    else if (leave || status === 'OnLeave') category = 'leave';
    else if (status === 'Absent') category = 'absent';
    if (category) {
      const day = { date: key, category };
      // Punch details for worked days (also surfaced for half-days).
      if (rec) {
        if (rec.checkIn) day.checkIn = rec.checkIn;
        if (rec.checkOut) day.checkOut = rec.checkOut;
        if (rec.hoursWorked) day.hoursWorked = rec.hoursWorked;
        if (rec.noPunchOut) day.noPunchOut = true;
        if (rec.checkInWfh || rec.checkOutWfh) day.wfh = true;
        if (rec.remarks) day.remarks = rec.remarks;
        // Flag a late arrival on an otherwise full day (checked in after the
        // configured late cut-off). Kept as a flag on category 'full'
        // so clients unaware of "late" still render it as a normal full day.
        if (category === 'full' && lateMinutes(rec) > 0) day.late = true;
      }
      if (category === 'leave' && leave) {
        day.leaveType = leave.type;
        if (leave.half) day.halfDaySession = leave.session || true;
      }
      days.push(day);
    }
    cur.setDate(cur.getDate() + 1);
  }

  res.json({ from: ymdLocal(start), to: ymdLocal(end), days });
});

// GET /api/attendance/org/heatmap?days=365  (HR/Admin)
// Org-wide daily attendance counts for a heatmap: per day, how many employees
// were full-day / half-day / on leave / comp-off / absent. Intensity = number
// present (full + half). One category per employee per day, same precedence as
// the personal heatmap: worked > comp-off > leave > absent.
// Shared aggregation for the org/team heatmap. `empIds` scopes it to a set of
// EmployeeProfile ids (a manager's direct reports); pass null for the whole org.
// One category per (employee, day); intensity = present (full + half). `late` is
// a sub-count of full days where the check-in was after the configured late
// cut-off (present people who arrived late).
const computeHeatmapWindow = async ({ empIds, span }) => {
  const { LeaveRequest } = require('../models/Leave');
  const CompOff = require('../models/CompOff');

  const end = startOfDay(new Date());
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - (span - 1));

  const profiles = await EmployeeProfile.find(empIds ? { _id: { $in: empIds } } : {})
    .select('_id user').lean();
  const idSet = new Set(profiles.map((p) => String(p._id)));
  const userIds = profiles.map((p) => p.user).filter(Boolean);
  // CompOff.employee is a User id; map it to the EmployeeProfile id used elsewhere.
  const userToEmp = {};
  for (const p of profiles) userToEmp[String(p.user)] = String(p._id);

  const attFilter = { date: { $gte: start, $lte: end } };
  const leaveFilter = { status: 'Approved', startDate: { $lte: end }, endDate: { $gte: start } };
  const compFilter = { status: 'Availed', availedOn: { $gte: start, $lte: end } };
  if (empIds) {
    attFilter.employee = { $in: empIds };
    leaveFilter.employee = { $in: empIds };
    compFilter.employee = { $in: userIds };
  }

  const [records, leaves, comps] = await Promise.all([
    Attendance.find(attFilter).select('employee date status checkIn halfDayDeclared shift shiftName shiftStart shiftEnd shiftDurationMin shiftCrossesMidnight').lean(),
    LeaveRequest.find(leaveFilter).select('employee startDate endDate').lean(),
    CompOff.find(compFilter).select('employee availedOn').lean(),
  ]);

  // One category per (employee, day); `lateSet` marks the late full days.
  const cls = new Map(); // `${empId}|${ymd}` -> category
  const lateSet = new Set();

  for (const r of records) {
    if (empIds && !idSet.has(String(r.employee))) continue;
    const key = `${String(r.employee)}|${ymdLocal(r.date)}`;
    if (r.status === 'Present') {
      cls.set(key, 'full');
      if (lateMinutes(r) > 0) lateSet.add(key);
    } else if (r.status === 'HalfDay') cls.set(key, 'half');
    else if (r.status === 'OnLeave') cls.set(key, 'leave');
    else if (r.status === 'Absent') cls.set(key, 'absent');
  }

  // Approved leave ranges fill in days that are empty or only marked absent.
  for (const lv of leaves) {
    const emp = String(lv.employee);
    const d = startOfDay(new Date(lv.startDate));
    const last = startOfDay(new Date(lv.endDate));
    while (d <= last) {
      if (d >= start && d <= end) {
        const key = `${emp}|${ymdLocal(d)}`;
        const cur = cls.get(key);
        if (!cur || cur === 'absent') cls.set(key, 'leave');
      }
      d.setDate(d.getDate() + 1);
    }
  }

  // Availed comp-off beats everything except an actual worked day.
  for (const c of comps) {
    if (!c.availedOn) continue;
    const emp = userToEmp[String(c.employee)];
    if (!emp) continue;
    const key = `${emp}|${ymdLocal(c.availedOn)}`;
    const cur = cls.get(key);
    if (cur !== 'full' && cur !== 'half') cls.set(key, 'compoff');
  }

  const byDay = {};
  for (const [key, cat] of cls) {
    const ymd = key.split('|')[1];
    const b = byDay[ymd] || (byDay[ymd] = { date: ymd, full: 0, half: 0, leave: 0, compoff: 0, absent: 0, late: 0 });
    b[cat] += 1;
    if (cat === 'full' && lateSet.has(key)) b.late += 1;
  }

  let maxPresent = 0;
  const days = Object.values(byDay).map((b) => {
    const present = b.full + b.half;
    if (present > maxPresent) maxPresent = present;
    return { ...b, present };
  });

  return { from: ymdLocal(start), to: ymdLocal(end), totalEmployees: profiles.length, maxPresent, days };
};

// Shared per-day breakdown WITH employee names, for the heatmap click-through
// modal. Same classification/precedence as the heatmap. `empIds` scopes to a
// manager's reports; null = whole org.
const computeDayDetails = async ({ empIds, dateStr }) => {
  const { LeaveRequest } = require('../models/Leave');
  const CompOff = require('../models/CompOff');

  const day = new Date(`${dateStr}T00:00:00+05:30`); // IST midnight of that day
  const next = new Date(day);
  next.setDate(day.getDate() + 1);

  const profiles = await EmployeeProfile.find(empIds ? { _id: { $in: empIds } } : {})
    .select('_id user employeeCode designation department dateOfJoining dateOfExit')
    .populate('user', 'firstName lastName isActive')
    .lean();
  const byId = new Map(profiles.map((p) => [String(p._id), p]));
  const userIds = profiles.map((p) => p.user?._id || p.user).filter(Boolean);
  const userToEmp = {};
  for (const p of profiles) userToEmp[String(p.user?._id || p.user)] = String(p._id);

  const attFilter = { date: { $gte: day, $lt: next } };
  const leaveFilter = { status: 'Approved', startDate: { $lte: day }, endDate: { $gte: day } };
  const compFilter = { status: 'Availed', availedOn: { $gte: day, $lt: next }, employee: { $in: userIds } };
  if (empIds) {
    attFilter.employee = { $in: empIds };
    leaveFilter.employee = { $in: empIds };
  }

  const [records, leaves, comps, holidays] = await Promise.all([
    Attendance.find(attFilter)
      .select('employee status checkIn checkOut date halfDayDeclared shift shiftName shiftStart shiftEnd shiftDurationMin shiftCrossesMidnight')
      .lean(),
    LeaveRequest.find(leaveFilter).select('employee leaveType isHalfDay halfDaySession').lean(),
    CompOff.find(compFilter).select('employee availedOn').lean(),
    require('../models/Holiday').find({ date: { $gte: day, $lt: next } }).select('_id').lean().catch(() => []),
  ]);

  // Is this a non-working day? Sunday (weekly off) or a listed holiday. On those
  // days we don't auto-mark unpunched employees as absent. Weekday is derived from
  // the date string so it's timezone-independent (0 = Sunday).
  const [wy, wm, wd] = dateStr.split('-').map(Number);
  const isSunday = new Date(Date.UTC(wy, wm - 1, wd)).getUTCDay() === 0;
  const isNonWorkingDay = isSunday || (holidays && holidays.length > 0);

  const cat = new Map();  // empId -> category
  const info = new Map(); // empId -> extra fields

  for (const r of records) {
    const id = String(r.employee);
    if (!byId.has(id)) continue;
    if (r.status === 'Present') {
      // Judged per record, not against one hoisted org-wide cut-off: with
      // per-employee shifts there is no single instant the whole company is
      // late after. lateMinutes() reads each record's own frozen shift, so a
      // night worker is not reported late here after payroll has stopped
      // charging them for it.
      const late = r.checkIn ? lateMinutes(r) > 0 : false;
      cat.set(id, 'full');
      info.set(id, { checkIn: r.checkIn || null, checkOut: r.checkOut || null, late });
    } else if (r.status === 'HalfDay') { cat.set(id, 'half'); info.set(id, { checkIn: r.checkIn || null }); }
    else if (r.status === 'OnLeave') cat.set(id, 'leave');
    else if (r.status === 'Absent') cat.set(id, 'absent');
  }
  for (const lv of leaves) {
    const id = String(lv.employee);
    if (!byId.has(id)) continue;
    const cur = cat.get(id);
    if (!cur || cur === 'absent') {
      cat.set(id, 'leave');
      info.set(id, { leaveType: lv.leaveType, half: !!lv.isHalfDay, session: lv.halfDaySession || null });
    }
  }
  for (const c of comps) {
    const id = userToEmp[String(c.employee)];
    if (!id || !byId.has(id)) continue;
    const cur = cat.get(id);
    if (cur !== 'full' && cur !== 'half') cat.set(id, 'compoff');
  }

  // Fill in absentees: any employee who is active and employed on this working
  // day, but has no punch / leave / comp-off, is counted as absent. Skipped on
  // Sundays and holidays so a weekend worker doesn't flag everyone else absent.
  if (!isNonWorkingDay) {
    for (const p of profiles) {
      const id = String(p._id);
      if (cat.has(id)) continue;
      if (p.user?.isActive === false) continue;                       // deactivated login
      if (p.dateOfExit && new Date(p.dateOfExit) <= day) continue;    // already exited
      if (p.dateOfJoining && new Date(p.dateOfJoining) >= next) continue; // not yet joined
      cat.set(id, 'absent');
    }
  }

  const nameOf = (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode || 'Unknown';
  const person = (id, extra = {}) => {
    const p = byId.get(id);
    return {
      name: nameOf(p),
      employeeCode: p.employeeCode || '',
      designation: p.designation || '',
      department: p.department || '',
      ...extra,
    };
  };

  const present = [], late = [], half = [], leave = [], compoff = [], absent = [];
  for (const [id, c] of cat) {
    const x = info.get(id) || {};
    if (c === 'full') {
      present.push(person(id, { checkIn: x.checkIn, checkOut: x.checkOut, late: !!x.late }));
      if (x.late) late.push(person(id, { checkIn: x.checkIn }));
    } else if (c === 'half') half.push(person(id, { checkIn: x.checkIn }));
    else if (c === 'leave') leave.push(person(id, { leaveType: x.leaveType || '', half: !!x.half, session: x.session || null }));
    else if (c === 'compoff') compoff.push(person(id));
    else if (c === 'absent') absent.push(person(id));
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  [present, late, half, leave, compoff, absent].forEach((l) => l.sort(byName));

  return {
    date: dateStr,
    counts: {
      total: profiles.length,
      present: present.length,
      late: late.length,
      half: half.length,
      leave: leave.length,
      compoff: compoff.length,
      absent: absent.length,
    },
    present, late, half, leave, compoff, absent,
  };
};

/**
 * Org-wide daily attendance counts for a heatmap (delegates to computeHeatmapWindow).
 * @route GET /api/attendance/org/heatmap?days=365  (HR/Admin)
 * @param {number} [req.query.days] - trailing window, capped at 400
 * @returns {{from, to, totalEmployees, maxPresent, days}}
 */
const orgHeatmap = asyncHandler(async (req, res) => {
  const span = Math.min(Number(req.query.days) || 365, 400);
  // Scope to the employees this admin may see (HR Manager → their own; a
  // company-limited exec → their companies; Backend → everyone / null).
  res.json(await computeHeatmapWindow({ empIds: await allowedEmployeeIds(req), span }));
});

/**
 * Named per-day breakdown for the whole org (heatmap click-through).
 * @route GET /api/attendance/org/day?date=YYYY-MM-DD  (HR/Admin)
 * @param {string} req.query.date - YYYY-MM-DD (required)
 * @returns {{date, counts, present, late, half, leave, compoff, absent}}
 */
// GET /api/attendance/org/day?date=YYYY-MM-DD  (HR/Admin) — who was late / on
// leave / present / absent on a given day, by name (heatmap click-through).
const orgDayDetails = asyncHandler(async (req, res) => {
  const dateStr = String(req.query.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    res.status(400);
    throw new Error('A valid date (YYYY-MM-DD) is required.');
  }
  res.json(await computeDayDetails({ empIds: await allowedEmployeeIds(req), dateStr }));
});

/**
 * List the caller's attendance records for a month, plus today's record.
 * @route GET /api/attendance/me?year=&month=
 * @param {number} [req.query.year] / [req.query.month] - default current
 * @returns {{year, month, today, count, records}}
 */
// GET /api/attendance/me?year=&month=
const listMine = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const upto = capToToday(end);
  const [records, holidays] = await Promise.all([
    Attendance.find({
      employee: profile._id,
      date: { $gte: start, $lt: upto },
    }).sort({ date: 1 }),
    // Holidays keep the full month — an upcoming holiday is a published plan,
    // not a claim about attendance that has already happened.
    require('../models/Holiday').find({ date: { $gte: start, $lt: end } }).select('date type').lean().catch(() => []),
  ]);

  // The day the punch buttons act on. For an overnight shift that is still
  // running past midnight this is LAST NIGHT's record, not today's empty one:
  // showing a night worker a fresh day with a Punch In button at 00:30 is how
  // a second record gets created for a shift they are in the middle of.
  const todayKey = startOfDay(new Date()).getTime();
  const openShift = await openShiftRecord(profile._id, new Date());
  const today = (openShift && records.find((r) => String(r._id) === String(openShift._id)))
    || records.find((r) => startOfDay(r.date).getTime() === todayKey)
    || null;

  // Employees see their own lateness — the penalty comes out of their pay, so
  // the figure that drives it should not be admin-only. Same reasoning for the
  // rest-day duty state: a Sunday / comp-off day they worked is worth double
  // once approved, so they should see whether it still needs a decision.
  const compOffKeys = compOffKeysFor(holidays);
  const out = records.map((r) => {
    const o = r.toJSON();
    o.lateMinutes = lateMinutes(r);
    o.doublePayState = doublePayState(r, compOffKeys);   // Pending | Approved | Rejected | null
    return o;
  });

  // Is today a day this employee is on approved leave? Sent so the punch screen
  // can warn BEFORE the punch — the server warns again on the response, but by
  // then the claim already exists, which is a worse moment to learn about it.
  // Skipped once a claim exists for today: the record itself then says more.
  let todayLeave = null;
  if (!today?.workOnLeave?.status) {
    try {
      const leave = await leaveCoveringDay(profile._id, startOfDay(new Date()));
      if (leave) {
        const top = await topLeaveApproverFor(profile);
        todayLeave = {
          leaveType: leave.leaveType,
          startDate: leave.startDate,
          endDate: leave.endDate,
          approverName: top?.approverName || '',
        };
      }
    } catch (err) {
      // Best-effort: a failure here must never break the attendance screen.
      console.error('todayLeave lookup failed:', err.message);
    }
  }

  res.json({
    year,
    month,
    today,
    count: out.length,
    records: out,
    // Whether this employee may mark a punch as work-from-home (granted by a
    // SuperAdmin) — drives whether the WFH control is shown at all.
    wfhAllowed: !!profile.wfhAllowed,
    // Whether the office geofence applies to them at all. Told to the employee
    // so a punch from a site does not look like something they got away with.
    remotePunchAllowed: !!profile.remotePunchAllowed,
    todayLeave,
  });
});

// ===== HR/Admin =====

/**
 * List attendance records for a month (optionally one employee) with punch distances.
 * @route GET /api/attendance?year=&month=&employee=  (HR/Admin)
 * @param {number} [req.query.year] / [req.query.month]
 * @param {string} [req.query.employee] - EmployeeProfile id
 * @returns {{year, month, count, records, settings}}
 */
// GET /api/attendance?year=&month=&employee=
const listAll = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const filter = { date: { $gte: start, $lt: capToToday(end) } };
  if (req.query.employee) filter.employee = req.query.employee;
  // Limit to the employees this admin may see (also intersects a specific
  // ?employee= against their scope).
  await scopeEmployeeFilter(req, filter);

  const records = await Attendance.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user workLocationRef remotePunchAllowed',
      populate: [
        { path: 'user', select: 'firstName lastName email' },
        { path: 'workLocationRef', select: 'name lat lng radiusM' },
      ],
    })
    .sort({ date: -1, createdAt: -1 });

  // Attach each punch's distance from the employee's own work location (or the
  // global office if unassigned), plus that location's name/radius, for HR review.
  const settings = await Setting.getSettings();
  const office = settings.office;
  const out = records.map((r) => {
    const o = r.toJSON();
    const geo = resolveGeofence(r.employee, settings);
    o.checkInDistanceM = haversineMeters(geo.center, o.checkInLocation);
    o.checkOutDistanceM = haversineMeters(geo.center, o.checkOutLocation);
    o.geofenceRadiusM = geo.radiusM;
    o.locationName = geo.label;
    // So a screen can explain a long distance that is not a finding, rather
    // than leaving HR to wonder why it is not flagged.
    o.remotePunchAllowed = geo.exempt;
    return o;
  });

  res.json({
    year,
    month,
    count: out.length,
    records: out,
    settings: {
      office,
      geofenceThresholdM: settings.geofenceThresholdM,
      // The admin page edits these in the same modal as the geofence, so they
      // travel with the records rather than costing a second round trip.
      //
      // minPresentHours MUST be here even though only a SuperAdmin can change it:
      // the modal hydrates its form from this payload and posts every field back,
      // so omitting it would hydrate the default and silently reset a configured
      // threshold the next time anyone saved the office address.
      latePolicy: settings.latePolicy,
      minPresentHours: settings.minPresentHours,
    },
  });
});

/**
 * One employee's whole month with per-day flags and roll-up summary counts.
 * @route GET /api/attendance/month-summary?employee=&year=&month=  (HR/Admin)
 * @param {string} req.query.employee - EmployeeProfile id (required)
 * @param {number} [req.query.year] / [req.query.month]
 * @returns {{year, month, employee, summary, records, settings}}
 */
// GET /api/attendance/month-summary?employee=&year=&month=
// One employee's whole month for HR/admin review: every day's punches with
// late / distance / no-punch-out flags, plus the roll-up counts shown in the
// summary bar (working days, on-time, late, leave …).
const monthSummary = asyncHandler(async (req, res) => {
  if (!req.query.employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const [profile, records, settings, holidays] = await Promise.all([
    EmployeeProfile.findById(req.query.employee)
      .select('employeeCode designation department user workLocationRef remotePunchAllowed')
      .populate('user', 'firstName lastName email')
      .populate('workLocationRef', 'name lat lng radiusM'),
    // Capped at today like the registers: a leave approved for later this month
    // must not be counted as attendance that has already happened.
    Attendance.find({ employee: req.query.employee, date: { $gte: start, $lt: capToToday(end) } }).sort({ date: -1 }),
    Setting.getSettings(),
    // Holidays keep the full month — an upcoming holiday is a published plan.
    require('../models/Holiday').find({ date: { $gte: start, $lt: end } }).select('date name').catch(() => []),
  ]);
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only view employees assigned to you');
  }

  const office = settings.office;
  const threshold = settings.geofenceThresholdM;
  // This employee's geofence: their assigned work location, or the office.
  const geo = resolveGeofence(profile, settings);
  const todayStart = startOfDay(new Date());
  const holidayKeys = new Set((holidays || []).map((h) => ymdLocal(h.date)));

  const days = records.map((r) => {
    const o = r.toJSON();
    o.lateMinutes = lateMinutes(r);
    o.checkInDistanceM = haversineMeters(geo.center, o.checkInLocation);
    o.checkOutDistanceM = haversineMeters(geo.center, o.checkOutLocation);
    o.geofenceRadiusM = geo.radiusM;
    o.locationName = geo.label;
    // `geo.exempt` = this employee may punch from anywhere, so the distance is
    // still reported but is never a finding.
    o.distantPunch = Boolean(
      !geo.exempt && geo.radiusM &&
      ((o.checkInDistanceM != null && o.checkInDistanceM > geo.radiusM && !o.checkInWfh) ||
        (o.checkOutDistanceM != null && o.checkOutDistanceM > geo.radiusM && !o.checkOutWfh))
    );
    // Show "no punch-out" as soon as the day is over, even before the nightly
    // worker stamps it.
    o.noPunchOut = o.noPunchOut || Boolean(r.checkIn && !r.checkOut && startOfDay(r.date) < todayStart);
    return o;
  });

  // Working days this month = calendar days minus Sundays minus listed holidays.
  const daysInMonth = Math.round((end - start) / 86400000);
  let workingDays = 0;
  for (let i = 0; i < daysInMonth; i += 1) {
    const d = new Date(start.getTime() + i * 86400000 + 12 * 3600000); // midday, DST-safe
    const key = ymdLocal(d);
    const istDow = new Date(d.getTime()).getUTCDay(); // d is IST-anchored midday
    if (istDow !== 0 && !holidayKeys.has(key)) workingDays += 1;
  }

  const present = days.filter((d) => ['Present', 'HalfDay'].includes(d.status) && d.checkIn);
  const summary = {
    workingDays,
    presentDays: present.length,
    onTime: present.filter((d) => d.lateMinutes === 0).length,
    late: present.filter((d) => d.lateMinutes > 0).length,
    leave: days.filter((d) => d.status === 'OnLeave').length,
    halfDay: days.filter((d) => d.status === 'HalfDay').length,
    absent: days.filter((d) => d.status === 'Absent').length,
    holiday: days.filter((d) => ['Holiday', 'WeeklyOff'].includes(d.status)).length,
    noPunchOut: days.filter((d) => d.noPunchOut).length,
    distantPunches: days.filter((d) => d.distantPunch).length,
    totalHours: +days.reduce((a, d) => a + (d.hoursWorked || 0), 0).toFixed(1),
  };

  res.json({
    year,
    month,
    employee: profile,
    summary,
    records: days,
    settings: { office, geofenceThresholdM: threshold },
  });
});

/**
 * Every GPS-tagged punch plotted as map points plus the geofence circles.
 * @route GET /api/attendance/punch-map?year=&month=&day=  (HR/Admin)
 * @param {number} [req.query.year] / [req.query.month]
 * @param {number} [req.query.day] - 1-31 narrows to one IST day; omit for the month
 * @returns {{year, month, day, count, points, office, geofenceThresholdM, geofences}}
 */
// GET /api/attendance/punch-map?year=&month=&day=   (HR/Admin)
// Every GPS-tagged punch (check-in & check-out) plotted as map points, so HR can
// see exactly WHERE people punched. `day` (1-31) narrows to a single IST day;
// omit it for the whole month. Each punch with a captured location becomes one
// point carrying the employee, in/out kind, exact time, distance from their work
// area and whether it fell outside the geofence. Also returns the office + the
// distinct work-location geofences referenced, so the map can draw their circles.
const punchMap = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const day = Number(req.query.day) || 0; // 0 ⇒ whole month

  let start;
  let end;
  const pad = (n) => String(n).padStart(2, '0');
  if (day >= 1 && day <= 31) {
    start = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00+05:30`);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  } else {
    ({ start, end } = monthRange(year, month));
  }

  const punchFilter = {
    date: { $gte: start, $lt: end },
    // Only records that captured at least one GPS fix are useful on a map.
    $or: [{ 'checkInLocation.lat': { $ne: null } }, { 'checkOutLocation.lat': { $ne: null } }],
  };
  if (req.query.employee) punchFilter.employee = req.query.employee;
  await scopeEmployeeFilter(req, punchFilter);

  const [records, settings] = await Promise.all([
    Attendance.find(punchFilter).populate({
      path: 'employee',
      select: 'employeeCode designation department user workLocationRef remotePunchAllowed',
      populate: [
        { path: 'user', select: 'firstName lastName' },
        { path: 'workLocationRef', select: 'name lat lng radiusM' },
      ],
    }),
    Setting.getSettings(),
  ]);

  const points = [];
  const geofences = new Map(); // label → { label, lat, lng, radiusM }

  for (const r of records) {
    const p = r.employee;
    if (!p || !p.user) continue;
    const geo = resolveGeofence(p, settings);
    if (geo.center && geo.center.lat != null) {
      const key = `${geo.label}|${geo.center.lat}|${geo.center.lng}`;
      if (!geofences.has(key)) {
        geofences.set(key, { label: geo.label, lat: geo.center.lat, lng: geo.center.lng, radiusM: geo.radiusM });
      }
    }
    const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.employeeCode;
    const base = {
      recordId: String(r._id),
      employeeId: String(p._id),
      employeeCode: p.employeeCode || '',
      name,
      designation: p.designation || '',
      department: p.department || '',
      date: ymdLocal(r.date),
      geofenceRadiusM: geo.radiusM,
      locationName: geo.label,
      remotePunchAllowed: geo.exempt,
    };

    const addPoint = (kind, loc, time, wfh) => {
      if (!loc || loc.lat == null || loc.lng == null) return;
      const distanceM = haversineMeters(geo.center, loc);
      // Not flagged for somebody the fence does not apply to — the pin still
      // drops where they punched, it just is not marked as a problem.
      const outside = Boolean(geo.radiusM && !wfh && !geo.exempt && distanceM != null && distanceM > geo.radiusM);
      points.push({
        ...base,
        id: `${base.recordId}-${kind}`,
        kind, // 'in' | 'out'
        time: time || null,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: loc.accuracy != null ? loc.accuracy : null,
        wfh: !!wfh,
        outside,
        distanceM,
      });
    };

    addPoint('in', r.checkInLocation, r.checkIn, r.checkInWfh);
    addPoint('out', r.checkOutLocation, r.checkOut, r.checkOutWfh);
  }

  res.json({
    year,
    month,
    day: day || null,
    count: points.length,
    points,
    office: settings.office,
    geofenceThresholdM: settings.geofenceThresholdM,
    geofences: [...geofences.values()],
  });
});

// Column layout for the attendance export (order = worksheet column order).
const ATT_EXPORT_COLUMNS = [
  { header: 'Employee Code', width: 14 },
  { header: 'Name', width: 22 },
  { header: 'Email', width: 26 },
  { header: 'Date', width: 12 },
  { header: 'Weekday', width: 10 },
  { header: 'Status', width: 12 },
  { header: 'Check In', width: 12 },
  { header: 'Check Out', width: 12 },
  { header: 'Hours Worked', width: 13 },
  // Two columns on purpose: the number stays sortable/summable in Excel, the
  // text one is what a person reads without decoding minutes in their head.
  { header: 'Late (min)', width: 10 },
  { header: 'Late By', width: 11 },
  { header: 'No Punch Out', width: 13 },
  { header: 'WFH', width: 7 },
  { header: 'Distant Punch', width: 13 },
  { header: 'Remarks', width: 34 },
];

// Turn attendance records into the ordered value rows for the export — one array
// of cell values per record, in ATT_EXPORT_COLUMNS order. Records are grouped per
// employee (by code) then chronological, which reads well for bulk/day exports.
function attendanceExportRows(records, settings) {
  const todayStart = startOfDay(new Date());
  const fmtT = (d) =>
    d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '';

  const ordered = records
    .filter((r) => r.employee)
    .sort((a, b) => {
      const ca = a.employee.employeeCode || '';
      const cb = b.employee.employeeCode || '';
      if (ca !== cb) return ca.localeCompare(cb);
      return new Date(a.date) - new Date(b.date);
    });

  return ordered.map((r) => {
    const p = r.employee;
    const u = p.user || {};
    const geo = resolveGeofence(p, settings);
    const inDist = haversineMeters(geo.center, r.checkInLocation);
    const outDist = haversineMeters(geo.center, r.checkOutLocation);
    const distant = Boolean(
      !geo.exempt && geo.radiusM &&
        ((inDist != null && inDist > geo.radiusM && !r.checkInWfh) ||
          (outDist != null && outDist > geo.radiusM && !r.checkOutWfh))
    );
    const lateMin = lateMinutes(r);
    const noPunchOut = r.noPunchOut || Boolean(r.checkIn && !r.checkOut && startOfDay(r.date) < todayStart);
    const weekday = new Date(r.date).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' });
    return [
      p.employeeCode || '',
      `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      u.email || '',
      ymdLocal(r.date),
      weekday,
      r.status || '',
      fmtT(r.checkIn),
      fmtT(r.checkOut),
      r.hoursWorked || 0,           // real number cell
      lateMin,                      // real number cell
      lateMin ? formatDuration(lateMin) : '',
      noPunchOut ? 'Yes' : '',
      r.checkInWfh || r.checkOutWfh ? 'Yes' : '',
      distant ? 'Yes' : '',
      r.remarks || '',
    ];
  });
}

// Build a real .xlsx workbook of attendance — one row per attendance day. Shared
// by the admin export and the manager (team) export so both produce identical
// columns. Follows the same ExcelJS pattern as services/employeeExcel.js.
function buildAttendanceWorkbook(records, settings) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();
  const ws = wb.addWorksheet('Attendance');
  ws.columns = ATT_EXPORT_COLUMNS.map((c) => ({ header: c.header, width: c.width }));

  // Header row styling (mirrors the employee export).
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.getRow(1).height = 20;
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });

  for (const row of attendanceExportRows(records, settings)) ws.addRow(row);
  return wb;
}

// Shared attendance-export runner (.xlsx workbook, one row per attendance
// day). A single code path serves every shape the UI offers, off these query
// params:  employee, year, month, day, months.
//   • day set (1-31)                    → one IST day  (day-wise export)
//   • employee set, months=1 (default)  → one employee, one month
//   • employee unset                    → every in-scope employee, that month
//   • employee set, months=N (2-12)     → one employee, the trailing N months
// `opts.scopeIds` (array of EmployeeProfile ids) limits the export to a subset —
// used by the manager route so a manager only exports their direct reports; when
// null (admin/HR), the whole org is in scope. `opts.bulkLabel` names the bulk
// file (e.g. 'all' vs 'team').
const runAttendanceExport = async (req, res, opts = {}) => {
  const scopeIds = opts.scopeIds || null;
  const bulkLabel = opts.bulkLabel || 'all';
  const pad = (n) => String(n).padStart(2, '0');

  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const months = Math.min(Math.max(Number(req.query.months) || 1, 1), 12);
  const day = Number(req.query.day) || 0; // 0 ⇒ whole month(s)

  // Resolve the date window. A specific day wins over the trailing-month window.
  let start;
  let end;
  let sy = year;
  let sm = month;
  const dayMode = day >= 1 && day <= 31;
  if (dayMode) {
    start = new Date(`${year}-${pad(month)}-${pad(day)}T00:00:00+05:30`);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  } else {
    sm = month - (months - 1);
    while (sm < 1) { sm += 12; sy -= 1; }
    ({ start } = monthRange(sy, sm));
    ({ end } = monthRange(year, month));
  }

  // Same rule as the on-screen registers: an export of the running month stops
  // at today rather than shipping rows for days that have not happened yet.
  const filter = { date: { $gte: start, $lt: capToToday(end) } };
  let employeeProfile = null;
  if (req.query.employee) {
    // When scoped (manager), the requested employee must be one of their reports.
    if (scopeIds && !scopeIds.some((id) => String(id) === String(req.query.employee))) {
      res.status(403);
      throw new Error('Not allowed to export this employee');
    }
    employeeProfile = await EmployeeProfile.findById(req.query.employee)
      .select('employeeCode user')
      .populate('user', 'firstName lastName');
    if (!employeeProfile) {
      res.status(404);
      throw new Error('Employee not found');
    }
    filter.employee = employeeProfile._id;
  } else if (scopeIds) {
    filter.employee = { $in: scopeIds };
  }

  const [records, settings] = await Promise.all([
    Attendance.find(filter).populate({
      path: 'employee',
      select: 'employeeCode user workLocationRef remotePunchAllowed',
      populate: [
        { path: 'user', select: 'firstName lastName email' },
        { path: 'workLocationRef', select: 'name lat lng radiusM' },
      ],
    }),
    Setting.getSettings(),
  ]);

  const wb = buildAttendanceWorkbook(records, settings);

  // Build a self-describing filename: attendance_<employee>_<month>_<day>.xlsx
  // where employee = the person's name (or 'all'/'team' for bulk), month = the
  // month name + year (or a range for a trailing-N-months export), and day = the
  // day number for a single-day export, else 'all'. Every segment is sanitized so
  // spaces/quotes can't break the Content-Disposition header.
  const sanitize = (s) => (s || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '');
  const monLabel = (y, m) => `${MONTH_NAMES[m - 1]}-${y}`;

  let empSeg;
  if (employeeProfile) {
    const name = `${employeeProfile.user?.firstName || ''} ${employeeProfile.user?.lastName || ''}`.trim();
    empSeg = sanitize(name) || sanitize(employeeProfile.employeeCode) || 'employee';
  } else {
    empSeg = bulkLabel; // 'all' (admin) | 'team' (manager)
  }
  const monthSeg = months > 1 ? `${monLabel(sy, sm)}-to-${monLabel(year, month)}` : monLabel(year, month);
  const daySeg = dayMode ? pad(day) : 'all';
  const fname = `attendance_${empSeg}_${monthSeg}_${daySeg}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  await wb.xlsx.write(res);
  res.end();
};

/**
 * Export attendance as an Excel workbook for the whole org (see runAttendanceExport
 * for the supported day/month/trailing-months shapes).
 * @route GET /api/attendance/export?employee=&year=&month=&day=&months=  (HR/Admin)
 * @returns {xlsx}
 */
// GET /api/attendance/export?employee=&year=&month=&day=&months=   (HR/Admin)
// Whole org in scope. See runAttendanceExport for the supported shapes.
const exportAttendance = asyncHandler(async (req, res) =>
  runAttendanceExport(req, res, { scopeIds: await allowedEmployeeIds(req) }));

/**
 * Per-day present count and average hours over the trailing N days (dashboard charts).
 * @route GET /api/attendance/daily-stats?days=14  (admin)
 * @param {number} [req.query.days] - clamped 1-60 (default 14)
 * @returns {{days: Array<{date, label, sunday, presentCount, avgHours}>}}
 */
// GET /api/attendance/daily-stats?days=14  (admin)
// Per-day org attendance for the dashboard bar charts: number of present
// employees and their average hours worked, over the trailing N IST days.
const dailyStats = asyncHandler(async (req, res) => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);
  const end = startOfDay(new Date());
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - (days - 1));

  const statsFilter = await scopeEmployeeFilter(req, { date: { $gte: start, $lte: end } });
  const records = await Attendance.find(statsFilter)
    .select('date status checkIn hoursWorked halfDayDeclared shift shiftName shiftStart shiftEnd shiftDurationMin shiftCrossesMidnight')
    .lean();

  // Seed every day in the window so the chart has no gaps.
  const byDay = {};
  for (let i = 0; i < days; i += 1) {
    const key = ymdLocal(new Date(start.getTime() + i * 86400000));
    byDay[key] = { date: key, present: 0, hoursSum: 0 };
  }
  for (const r of records) {
    const b = byDay[ymdLocal(r.date)];
    if (b && ['Present', 'HalfDay'].includes(r.status) && r.checkIn) {
      b.present += 1;
      b.hoursSum += r.hoursWorked || 0;
    }
  }

  const out = Object.values(byDay)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => {
      const [, m, d] = b.date.split('-').map(Number);
      return {
        date: b.date,
        label: `${d} ${MONTHS[m - 1]}`,
        // The chart draws a Sunday differently: nobody in means the day is
        // labelled rather than plotted as a zero, and anyone in makes it a
        // Sunday that was worked. Sent per day so the client never has to
        // re-derive the weekday from a formatted label.
        sunday: isSundayKey(b.date),
        presentCount: b.present,
        avgHours: b.present ? +(b.hoursSum / b.present).toFixed(1) : 0,
      };
    });
  res.json({ days: out });
});

/**
 * Today's clock-in/out board split into on-time vs late.
 * @route GET /api/attendance/today-board?department=  (admin)
 * @param {string} [req.query.department] - filter, or 'all'
 * @returns {{date, onTime, late, departments, counts}}
 */
// GET /api/attendance/today-board?department=
// Compact "Clock-In/Out" board for the admin dashboard: everyone who has
// punched in today, split into on-time vs late, with their clock in/out and
// production hours. "Late" = checked in after the standard start time.
//
// Both arrays stay sorted EARLIEST punch first. The web dashboard card shows
// only the few most recent arrivals and reverses them itself; the order is not
// flipped here because mobile's TodayAttendanceScreen reads these arrays
// straight through and reads chronologically.
const todayBoard = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const boardFilter = await scopeEmployeeFilter(req, {
    date: { $gte: today, $lt: tomorrow },
    checkIn: { $ne: null },
  });
  const records = await Attendance.find(boardFilter)
    .populate({
      path: 'employee',
      select: 'employeeCode designation department user',
      // `photo` costs nothing extra (a scalar on an already-populated doc) and
      // is what lets the dashboard card show a real face instead of initials.
      populate: { path: 'user', select: 'firstName lastName photo' },
    })
    .lean();

  let rows = records
    .filter((r) => r.employee && r.employee.user)
    .map((r) => {
      const p = r.employee;
      return {
        id: String(p._id),
        recordId: String(r._id),
        // The avatar endpoint is keyed by USER id, not profile id — `id` above
        // is the EmployeeProfile and cannot be used for it.
        userId: String(p.user._id),
        employeeCode: p.employeeCode,
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.employeeCode,
        designation: p.designation || '',
        department: p.department || 'Unassigned',
        checkIn: r.checkIn,
        checkOut: r.checkOut || null,
        hoursWorked: r.hoursWorked || 0,
        lateMinutes: lateMinutes(r),
        checkInWfh: !!r.checkInWfh,
        // Only whether a face exists — the images themselves stay behind their
        // own authorised endpoints, same as the presence board does it.
        hasAvatar: Boolean(p.user.photo),
        hasCheckInPhoto: !!(r.checkInPhoto || r.checkInPhotoCloud?.publicId),
      };
    });

  const dept = req.query.department;
  if (dept && dept !== 'all') rows = rows.filter((r) => r.department === dept);

  rows.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));

  // Scoped, not `distinct('department')` bare: an unfiltered distinct hands a
  // single-company admin every OTHER company's department names, which the
  // company wall exists to prevent (and selecting one just returns nothing).
  const departments = (await EmployeeProfile.distinct('department', employeeProfileScope(req)))
    .filter(Boolean)
    .sort();

  const onTime = rows.filter((r) => r.lateMinutes === 0);
  const late = rows.filter((r) => r.lateMinutes > 0);

  res.json({
    date: today,
    onTime,
    late,
    departments,
    // Counts describe exactly the rows returned (so they follow the department
    // filter). They exist so a card can cap its list without losing the totals.
    counts: {
      total: rows.length,
      onTime: onTime.length,
      late: late.length,
      clockedOut: rows.filter((r) => r.checkOut).length,
      stillIn: rows.filter((r) => !r.checkOut).length,
    },
  });
});

/**
 * Today's presence snapshot: who's present / on leave / absent (one row per active employee).
 * @route GET /api/attendance/presence-board?department=  (HR/Admin)
 * @param {string} [req.query.department] - filter, or 'all'
 * @returns {{date, counts, present, onLeave, absent, departments}}
 */
// GET /api/attendance/presence-board?department=
// A single "who's in / who's on leave / who's absent" snapshot for today, for
// HR/Admin. Combines today's punches (with the check-in selfie, captured the
// same way from web or mobile) with approved leave that covers today, then lists
// everyone else (active, non-exited) as absent. One row per active employee.
const presenceBoard = asyncHandler(async (req, res) => {
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const { LeaveRequest } = require('../models/Leave');

  const [profiles, records, leaves] = await Promise.all([
    // Scoped roster — the present/leave/absent split is computed from this set,
    // so an HR Manager's board only ever counts their own assigned employees.
    EmployeeProfile.find(employeeProfileScope(req))
      .select('employeeCode designation department user dateOfExit')
      .populate('user', 'firstName lastName photo isActive')
      .lean(),
    Attendance.find({ date: { $gte: today, $lt: tomorrow }, checkIn: { $ne: null } })
      .select('employee date checkIn checkOut checkInPhoto checkOutPhoto checkInPhotoCloud checkOutPhotoCloud checkInWfh hoursWorked status workOnLeave halfDayDeclared shift shiftName shiftStart shiftEnd shiftDurationMin shiftCrossesMidnight')
      .lean(),
    LeaveRequest.find({ status: 'Approved', startDate: { $lt: tomorrow }, endDate: { $gte: today } })
      .select('employee leaveType isHalfDay halfDaySession startDate endDate reason workedDays')
      .lean(),
  ]);

  // Only active, not-yet-exited employees make up the headcount.
  const activeProfiles = profiles.filter(
    (p) => p.user && p.user.isActive !== false && (!p.dateOfExit || new Date(p.dateOfExit) > today)
  );
  const byId = new Map(activeProfiles.map((p) => [String(p._id), p]));

  const personCore = (p) => ({
    profileId: String(p._id),
    userId: p.user ? String(p.user._id) : null,
    name: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode,
    employeeCode: p.employeeCode,
    designation: p.designation || '',
    department: p.department || 'Unassigned',
    hasAvatar: Boolean(p.user?.photo),
  });

  // A punch puts you in the present list — unless the day's own record still
  // says the day is leave, which is the case while a work-on-leave claim is
  // undecided. Those people belong in the leave list until it is approved, so
  // this board and the dashboard donut tell the same story about them.
  const presentIds = new Set();
  const present = records
    .filter((r) => byId.has(String(r.employee))
      && !(r.workOnLeave && r.workOnLeave.status === 'Pending'))
    .map((r) => {
      const p = byId.get(String(r.employee));
      presentIds.add(String(r.employee));
      return {
        ...personCore(p),
        recordId: String(r._id),
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut || null,
        hoursWorked: r.hoursWorked || 0,
        checkInWfh: !!r.checkInWfh,
        lateMinutes: lateMinutes(r),
        hasCheckInPhoto: !!(r.checkInPhoto || r.checkInPhotoCloud?.publicId),
        hasCheckOutPhoto: !!(r.checkOutPhoto || r.checkOutPhotoCloud?.publicId),
      };
    })
    .sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));

  // Someone can be on approved leave and still have punched in (e.g. half-day).
  // The present list wins; leave-only people go in the leave list.
  //
  // Two days are NOT leave any more: one the employee worked and had approved
  // back (`workedDays`), and one where they are already in the present list.
  // The `seen` guard is what keeps the row counts honest — an employee with two
  // approved leaves covering today would otherwise be listed (and counted) twice.
  const todayKey = ymdLocal(today);
  const leaveIds = new Set();
  const seen = new Set();
  const onLeave = leaves
    .filter((lv) => {
      const id = String(lv.employee);
      if (!byId.has(id) || presentIds.has(id) || seen.has(id)) return false;
      if ((lv.workedDays || []).includes(todayKey)) return false;
      seen.add(id);
      return true;
    })
    .map((lv) => {
      const p = byId.get(String(lv.employee));
      leaveIds.add(String(lv.employee));
      return {
        ...personCore(p),
        requestId: String(lv._id),
        leaveType: lv.leaveType,
        isHalfDay: !!lv.isHalfDay,
        halfDaySession: lv.halfDaySession || null,
        startDate: lv.startDate,
        endDate: lv.endDate,
        reason: lv.reason || '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Everyone left over: active, not present, not on leave.
  const absent = activeProfiles
    .filter((p) => !presentIds.has(String(p._id)) && !leaveIds.has(String(p._id)))
    .map((p) => personCore(p))
    .sort((a, b) => a.name.localeCompare(b.name));

  let present2 = present;
  let leave2 = onLeave;
  let absent2 = absent;
  const dept = req.query.department;
  if (dept && dept !== 'all') {
    present2 = present.filter((r) => r.department === dept);
    leave2 = onLeave.filter((r) => r.department === dept);
    absent2 = absent.filter((r) => r.department === dept);
  }

  const departments = [...new Set(activeProfiles.map((p) => p.department).filter(Boolean))].sort();

  res.json({
    date: today,
    counts: {
      total: dept && dept !== 'all'
        ? present2.length + leave2.length + absent2.length
        : activeProfiles.length,
      present: present2.length,
      onLeave: leave2.length,
      absent: absent2.length,
    },
    present: present2,
    onLeave: leave2,
    absent: absent2,
    departments,
  });
});

/**
 * Manually create an attendance record (HR/Admin).
 * @route POST /api/attendance
 * @param {string} req.body.employee - EmployeeProfile id (required)
 * @param {string} req.body.date - required
 * @param {string} [req.body.status='Present'] / [req.body.checkIn] / [req.body.checkOut] / [req.body.remarks]
 * @returns {{record: Object}} (201); 409 if the day already has a record
 */
// POST /api/attendance  (manual admin entry)
const createRecord = asyncHandler(async (req, res) => {
  const { employee, date, status, checkIn, checkOut, remarks } = req.body;
  if (!employee || !date) {
    res.status(400);
    throw new Error('employee and date are required');
  }
  const target = await EmployeeProfile.findById(employee).select('hrPartner company');
  if (!target) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, target)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  const day = startOfDay(date);
  const existing = await Attendance.findOne({ employee, date: day });
  if (existing) {
    res.status(409);
    throw new Error('Attendance for this date already exists; edit it instead');
  }
  const record = await Attendance.create({
    employee,
    date: day,
    status: status || 'Present',
    checkIn: checkIn || undefined,
    checkOut: checkOut || undefined,
    remarks,
  });
  res.status(201).json({ record });
});

/**
 * Write one audit row per punch time the Backend moved.
 *
 * Deliberately one row per field rather than a single "record edited": the
 * audit page lists rows of "X changed from A to B", and a reader should be able
 * to see that a check-in moved by two hours without opening anything.
 * Best-effort — the correction itself is already saved, and a failed audit
 * write must not turn a successful edit into an error.
 * @param {import('express').Request} req
 * @param {Object} record - the saved attendance record
 * @param {{checkIn: Date, checkOut: Date}} before - the times as they were
 * @param {string[]} changed - which of the two actually moved
 */
async function auditPunchEdit(req, record, before, changed) {
  try {
    const AuditLog = require('../models/AuditLog');
    const profile = await EmployeeProfile.findById(record.employee)
      .select('employeeCode user').populate('user', 'firstName lastName').lean();
    const who = `${profile?.user?.firstName || ''} ${profile?.user?.lastName || ''}`.trim()
      || profile?.employeeCode || 'Employee';
    // ymdLocal, not toISOString(): the stored day is an IST calendar day, and
    // converting it to UTC labels every record before 5:30 am as the day before
    // — the trap utils/istDate exists for. A wrong date on an audit row is
    // worse than none: it is evidence about the wrong day.
    const day = record.date ? ymdLocal(record.date) : '';
    const t = (v) => (v ? fmtIstTime(v) : '—');
    await AuditLog.insertMany(changed.map((field) => ({
      entity: 'Attendance',
      entityId: record._id,
      entityLabel: `${who}${day ? ` · ${day}` : ''}`,
      field,
      fromStatus: t(before[field]),
      toStatus: t(record[field]),
      by: req.user._id,
      byName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
      byRole: req.user.role,
    })));
  } catch (err) {
    console.error('punch-edit audit failed:', err.message);
  }
}

/**
 * Update an attendance record (employee/date immutable here).
 *
 * THE PUNCH TIMES ARE THE BACKEND'S ALONE. Everyone with `attendance.manage`
 * may correct the status and the remark; only a Super Admin may move a check-in
 * or check-out, because those two timestamps are payroll inputs — hours worked
 * comes off them, the half-day rule reads those hours, and the late-arrival
 * penalty is measured from the check-in. Anyone else's correction goes through
 * regularization, where somebody approves it. A time sent by a non-Backend
 * caller is dropped rather than refused, so HR's ordinary status edits keep
 * working exactly as before.
 *
 * Every time change is written to the audit log: this is a silent edit to
 * somebody's pay, and it should be answerable for afterwards.
 * @route PUT /api/attendance/:id  (HR/Admin; times: SuperAdmin only)
 * @param {string} req.params.id - record id
 * @param {Object} req.body - fields to update
 * @returns {{record: Object}}
 */
// PUT /api/attendance/:id
const updateRecord = asyncHandler(async (req, res) => {
  const record = await Attendance.findById(req.params.id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }
  const recProfile = await EmployeeProfile.findById(record.employee).select('hrPartner company');
  if (cannotManageProfile(req, recProfile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  // Don't allow changing employee or date here
  delete req.body.employee;
  delete req.body.date;

  const isBackend = req.user.role === 'SuperAdmin';
  const before = { checkIn: record.checkIn, checkOut: record.checkOut };
  if (!isBackend) {
    delete req.body.checkIn;
    delete req.body.checkOut;
  } else {
    // Blank clears a punch (a check-out entered by mistake, say); anything
    // unparseable is refused rather than quietly written as Invalid Date, which
    // would take the day's hours to zero without anyone noticing.
    for (const key of ['checkIn', 'checkOut']) {
      if (req.body[key] === undefined) continue;
      if (req.body[key] === null || req.body[key] === '') { req.body[key] = null; continue; }
      const t = new Date(req.body[key]);
      if (Number.isNaN(t.getTime())) {
        res.status(400);
        throw new Error(`${key === 'checkIn' ? 'Check-in' : 'Check-out'} is not a valid time.`);
      }
      req.body[key] = t;
    }
    const nextIn = req.body.checkIn !== undefined ? req.body.checkIn : record.checkIn;
    let nextOut = req.body.checkOut !== undefined ? req.body.checkOut : record.checkOut;
    // On a shift that runs past midnight an inverted pair is the NORMAL case,
    // not an error: the month editor builds both instants as record.date +
    // 'HH:mm', so a 4 AM close reads as 4 AM on the morning the shift started —
    // earlier than the 7 PM check-in. Refusing it meant HR could not correct a
    // night shift at all. Rolled forward with the same helper the employee-facing
    // regularization path uses, so the two cannot disagree about what 4 AM means.
    if (record.shiftCrossesMidnight && nextIn && nextOut) {
      nextOut = rollForwardIfInverted(new Date(nextIn), new Date(nextOut));
      if (req.body.checkOut !== undefined) req.body.checkOut = nextOut;
    }
    if (nextIn && nextOut && new Date(nextOut) <= new Date(nextIn)) {
      res.status(400);
      throw new Error(record.shiftCrossesMidnight
        ? 'Check-out has to be after check-in. For an overnight shift, enter the time it actually ended (for example 4:00 AM).'
        : 'Check-out has to be after check-in.');
    }
  }

  const statusChosen = req.body.status !== undefined;
  Object.assign(record, req.body);
  // HR's explicit status choice is final. When they only corrected the punch
  // times, re-derive from the hours so the half-day rule stays honest.
  if (!statusChosen) record.status = settleStatus(record) || record.status;
  await record.save();

  // Audit the times, after the save so only a change that stuck is recorded.
  // hoursWorked is recomputed by the model's pre-save hook, and lateness is
  // derived from checkIn at read time (payroll calls lateMinutes on the
  // record), so both follow the corrected times with nothing else to update.
  const changed = ['checkIn', 'checkOut'].filter(
    (k) => String(before[k] ? new Date(before[k]).toISOString() : '')
      !== String(record[k] ? new Date(record[k]).toISOString() : '')
  );
  if (changed.length) await auditPunchEdit(req, record, before, changed);

  res.json({ record });
});

/**
 * Get the office location, geofence threshold and late-marking policy.
 * @route GET /api/attendance/settings  (HR/Admin)
 * @returns {{office, geofenceThresholdM, attendanceReminders, latePolicy}}
 */
// GET /api/attendance/settings  (HR/Admin)
// Returns the office location + geofence threshold used for punch distances.
const getSettings = asyncHandler(async (req, res) => {
  const s = await Setting.getSettings();
  res.json({
    office: s.office,
    geofenceThresholdM: s.geofenceThresholdM,
    attendanceReminders: s.attendanceReminders,
    latePolicy: s.latePolicy,
    minPresentHours: s.minPresentHours,
  });
});

/**
 * Update the office coordinates/label, geofence threshold and/or the
 * late-marking policy (SuperAdmin only for the last two blocks).
 * @route PUT /api/attendance/settings  (HR/Admin)
 * @param {Object} [req.body.office] - {lat, lng, label}
 * @param {number} [req.body.geofenceThresholdM] - clamped >= 0
 * @param {Object} [req.body.latePolicy] - {hour, minute, graceMinutes}; SuperAdmin only
 * @param {number} [req.body.minPresentHours] - day-minimum hours, 0-6; SuperAdmin only
 * @returns {{office, geofenceThresholdM, attendanceReminders, latePolicy, minPresentHours}}
 */
// PUT /api/attendance/settings  (HR/Admin)
// Update the office coordinates/label and/or the geofence threshold (metres).
const updateSettings = asyncHandler(async (req, res) => {
  const s = await Setting.getSettings();
  const { lat, lng, label } = req.body.office || {};
  if (lat != null && Number.isFinite(Number(lat))) s.office.lat = Number(lat);
  if (lng != null && Number.isFinite(Number(lng))) s.office.lng = Number(lng);
  if (typeof label === 'string' && label.trim()) s.office.label = label.trim();
  if (req.body.geofenceThresholdM != null && Number.isFinite(Number(req.body.geofenceThresholdM))) {
    s.geofenceThresholdM = Math.max(0, Number(req.body.geofenceThresholdM));
  }

  // When the daily push reminders fire is a SuperAdmin decision — it pushes at
  // the whole company, so it sits above the attendance.manage crowd who own the
  // rest of this endpoint. Silently ignored for anyone else, matching how
  // employeeController strips its SuperAdmin-only fields.
  if (req.body.attendanceReminders && req.user.role === 'SuperAdmin') {
    for (const key of ['punchIn', 'punchOut']) {
      const incoming = req.body.attendanceReminders[key];
      if (!incoming) continue;
      const target = s.attendanceReminders[key];
      if (typeof incoming.enabled === 'boolean') target.enabled = incoming.enabled;
      // Clamped here as well as in the schema: an out-of-range hour would make
      // the reminder unreachable, and it would fail silently every day.
      if (Number.isFinite(Number(incoming.hour))) {
        target.hour = Math.min(23, Math.max(0, Math.trunc(Number(incoming.hour))));
      }
      if (Number.isFinite(Number(incoming.minute))) {
        target.minute = Math.min(59, Math.max(0, Math.trunc(Number(incoming.minute))));
      }
    }
  }

  // When lateness starts is a SuperAdmin decision for the same reason the
  // reminders above are: it applies to everyone and it costs money — payroll
  // charges ₹200/₹400 a day past the monthly late allowance. Ignored for anyone
  // else rather than refused, matching the block above.
  if (req.body.latePolicy && req.user.role === 'SuperAdmin') {
    // Clamped by normalizeLatePolicy as well as by the schema: an hour of 25 or
    // a NaN would either make every arrival late or none of them, silently.
    s.latePolicy = normalizeLatePolicy({ ...(s.latePolicy || {}), ...req.body.latePolicy });
  }

  // Same gate, same reasoning, one step further: below this many hours the day is
  // not short, it is absent, and payroll charges the day as loss of pay.
  if (req.body.minPresentHours !== undefined && req.user.role === 'SuperAdmin') {
    s.minPresentHours = normalizeMinPresentHours(req.body.minPresentHours);
  }

  await s.save();
  // Push the change into this process's cache immediately — services/latePolicy
  // would otherwise take up to five minutes to notice, and the admin who just
  // saved would see the old rule in the records they are looking at.
  setLatePolicy(s.latePolicy);
  setMinPresentHours(s.minPresentHours);
  res.json({
    office: s.office,
    geofenceThresholdM: s.geofenceThresholdM,
    attendanceReminders: s.attendanceReminders,
    latePolicy: getLatePolicy(),
    minPresentHours: getMinPresentHours(),
  });
});

/**
 * Delete an attendance record.
 * @route DELETE /api/attendance/:id  (HR/Admin)
 * @param {string} req.params.id - record id
 * @returns {{id: string, deleted: boolean}}
 */
// DELETE /api/attendance/:id
const deleteRecord = asyncHandler(async (req, res) => {
  const record = await Attendance.findById(req.params.id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }
  const recProfile = await EmployeeProfile.findById(record.employee).select('hrPartner company');
  if (cannotManageProfile(req, recProfile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  await record.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Rest-day duty (Sunday / Comp Off worked → double pay) =====

/**
 * Collect a month's rest-day duty claims — days that are a Sunday or an org-wide
 * Comp Off day AND were actually worked. Shared with the manager controller so
 * HR and a reporting manager see exactly the same list for their people.
 * @param {{empIds?: string[]|null, year: number, month: number, state?: string, employee?: string}} opts
 *   empIds scopes to a set of EmployeeProfile ids (a manager's reports); null = whole org.
 *   state ∈ pending|approved|rejected|all (default all).
 * @returns {Promise<{year, month, counts: {pending,approved,rejected}, claims: Object[]}>}
 */
async function buildRestDayClaims({ empIds = null, year, month, state = 'all', employee = null }) {
  const { start, end } = monthRange(year, month);

  const attFilter = { date: { $gte: start, $lt: end }, checkIn: { $ne: null } };
  if (employee) attFilter.employee = employee;
  else if (empIds) attFilter.employee = { $in: empIds };

  const [records, holidays] = await Promise.all([
    Attendance.find(attFilter)
      .select('employee date status checkIn checkOut hoursWorked doublePay remarks halfDayDeclared shift shiftName shiftStart shiftEnd shiftDurationMin shiftCrossesMidnight')
      .populate({ path: 'employee', select: 'employeeCode designation user', populate: { path: 'user', select: 'firstName lastName' } })
      .sort({ date: 1 })
      .lean(),
    require('../models/Holiday').find({ date: { $gte: start, $lt: end } }).select('date name type').lean().catch(() => []),
  ]);

  const compOffKeys = compOffKeysFor(holidays);
  const compOffNames = new Map(
    (holidays || []).filter((h) => h.type === COMP_OFF).map((h) => [ymdLocal(h.date), h.name])
  );

  const counts = { pending: 0, approved: 0, rejected: 0 };
  const claims = [];
  for (const r of records) {
    const st = doublePayState(r, compOffKeys);
    if (!st) continue;                       // ordinary working day, or nothing worked
    counts[st.toLowerCase()] += 1;
    if (state !== 'all' && st.toLowerCase() !== String(state).toLowerCase()) continue;
    const key = ymdLocal(r.date);
    claims.push({
      _id: r._id,
      date: r.date,
      status: r.status,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      hoursWorked: r.hoursWorked || 0,
      effectiveHours: effectiveHours(r),
      // What made the day a rest day, so the approver can see why it's claimable.
      dayType: compOffKeys.has(key) ? COMP_OFF : 'Sunday',
      dayName: compOffNames.get(key) || null,
      extraDays: restDayCredit(r),           // 1 or 0.5 — what approval would pay
      state: st,
      doublePay: r.doublePay || null,
      employee: r.employee
        ? {
          _id: r.employee._id,
          employeeCode: r.employee.employeeCode,
          designation: r.employee.designation,
          name: [r.employee.user?.firstName, r.employee.user?.lastName].filter(Boolean).join(' '),
        }
        : null,
    });
  }

  return { year, month, counts, claims };
}

/**
 * Record an approve/reject decision on one rest-day duty claim and tell the
 * employee. Shared by the HR and manager routes; the caller does the scoping.
 * @param {Object} record Attendance document (not lean)
 * @param {{decision: string, note?: string, by: Object}} input
 * @returns {Promise<Object>} the saved record
 * @sideeffect notifies the employee (employee-portal audience)
 */
async function applyRestDayDecision(record, { decision, note, by }) {
  const holidays = await require('../models/Holiday')
    .find({ date: { $gte: startOfDay(record.date), $lt: new Date(startOfDay(record.date).getTime() + 86400000) } })
    .select('date type').lean().catch(() => []);
  const state = doublePayState(record, compOffKeysFor(holidays));
  if (!state) {
    const err = new Error('That day is not a Sunday or comp-off day that was worked');
    err.status = 400;
    throw err;
  }

  record.doublePay = {
    status: decision,
    days: decision === 'Approved' ? restDayCredit(record) : 0,
    decidedBy: by._id,
    decidedAt: new Date(),
    note: note || undefined,
  };
  await record.save();

  const profile = await EmployeeProfile.findById(record.employee).select('user').lean();
  if (profile?.user) {
    const day = new Date(record.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    await notify({
      recipient: profile.user,
      type: 'attendance',
      audience: 'employee',
      title: decision === 'Approved' ? 'Double pay approved' : 'Double pay not approved',
      body: decision === 'Approved'
        ? `${day} — your rest-day working is approved for double pay.`
        : `${day} — your rest-day working was not approved for double pay.${note ? ` ${note}` : ''}`,
      link: 'attendance',
    }).catch(() => {});
  }

  return record;
}

/**
 * List rest-day duty claims for a month, org-wide.
 * @route GET /api/attendance/rest-day-work?year=&month=&state=&employee=  (HR/Admin)
 * @returns {{year, month, counts, claims}}
 */
// GET /api/attendance/rest-day-work
const listRestDayWork = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const empIds = await allowedEmployeeIds(req);
  const employee = req.query.employee || null;
  // A specific ?employee= outside this admin's scope returns nothing.
  if (employee && empIds && !empIds.some((id) => String(id) === String(employee))) {
    res.json({ year, month, counts: { pending: 0, approved: 0, rejected: 0 }, claims: [] });
    return;
  }
  res.json(await buildRestDayClaims({
    empIds,
    year,
    month,
    state: req.query.state || 'all',
    employee,
  }));
});

/**
 * Approve or reject one rest-day duty claim.
 * @route PATCH /api/attendance/rest-day-work/:id  (HR/Admin)
 * @param {'Approved'|'Rejected'} req.body.decision
 * @param {string} [req.body.note]
 * @returns {{record: Object}}
 */
// PATCH /api/attendance/rest-day-work/:id
const decideRestDayWork = asyncHandler(async (req, res) => {
  const decision = req.body.decision;
  if (!['Approved', 'Rejected'].includes(decision)) {
    res.status(400);
    throw new Error('decision must be Approved or Rejected');
  }
  const record = await Attendance.findById(req.params.id);
  if (!record) {
    res.status(404);
    throw new Error('Attendance record not found');
  }
  const rdProfile = await EmployeeProfile.findById(record.employee).select('hrPartner company');
  if (cannotManageProfile(req, rdProfile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  try {
    await applyRestDayDecision(record, { decision, note: req.body.note, by: req.user });
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ record });
});

module.exports = {
  checkIn,
  checkOut,
  getAttendancePhoto,
  myHeatmap,
  orgHeatmap,
  orgDayDetails,
  computeHeatmapWindow,
  computeDayDetails,
  listMine,
  listAll,
  monthSummary,
  exportAttendance,
  runAttendanceExport,
  punchMap,
  dailyStats,
  todayBoard,
  presenceBoard,
  createRecord,
  updateRecord,
  deleteRecord,
  listRestDayWork,
  decideRestDayWork,
  buildRestDayClaims,
  applyRestDayDecision,
  listWorkOnLeaveClaims,
  decideWorkOnLeave,
  healWorkOnLeaveClaims,
  getSettings,
  updateSettings,
};
