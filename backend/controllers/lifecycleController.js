/**
 * Lifecycle controller — employee probation/confirmation lifecycle on
 * EmployeeProfile. Lists confirmation-due employees, lets HR confirm/extend/reset
 * probation, and suggests the next employee code following the existing code style.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const { reservedAppointmentCodes } = require('../utils/reservedCodes');
// Company wall: confirmations list/act directly on EmployeeProfile.
const { employeeProfileScope, cannotManageProfile, assertCanEditProfileOf } = require('../utils/employeeScope');

// `role` rides along so the client knows which rows are Managers — confirming
// one needs the manager-profile grant (see assertCanEditProfileOf below) — and
// the user id so it can spot the admin's OWN row, which nobody confirms.
const USER_FIELDS = 'firstName lastName email role';

// Add `months` calendar months to a date, returning a new Date.
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Number(months || 0));
  return d;
};

// effectiveDueDate = explicit confirmationDueDate OR (dateOfJoining + probationMonths months)
const effectiveDueDate = (profile) => {
  if (profile.confirmationDueDate) return new Date(profile.confirmationDueDate);
  if (profile.dateOfJoining) {
    return addMonths(profile.dateOfJoining, profile.probationMonths != null ? profile.probationMonths : 6);
  }
  return null;
};

/**
 * How far ahead a confirmation counts as "coming up". The screen has always
 * flagged this window; it is named here because the sidebar badge counts the
 * same rows and the two must not be able to disagree about what "due" means.
 */
const DUE_WINDOW_DAYS = 30;
const MS_PER_DAY = 86400000;

/**
 * Is this person's confirmation waiting on somebody — due inside the window, or
 * already past it?
 *
 * THE ONE PLACE THIS IS DECIDED. It used to live only in the browser, as a
 * `days <= 30` test inside the table's render, which was fine while the table
 * was the only thing that asked. The sidebar badge asks too now, and the due
 * date is not a stored field — it is `confirmationDueDate` OR joining +
 * probation months, in CALENDAR months. Rebuilding that in an aggregation would
 * have given a second answer for free: Mongo's `$dateAdd` clamps 31 Jan + 1
 * month to 28 Feb, JavaScript's `setMonth` rolls it to 3 March. So the rule is
 * evaluated once, here, in JS, and both the list and the count call it.
 *
 * Already confirmed is never due — there is nothing left to do — and neither is
 * somebody with no joining date, because nothing says when they would be.
 * @param {Object} profile - an EmployeeProfile (lean is fine)
 * @param {Date} [asOf] - defaults to now
 * @returns {boolean}
 */
function isConfirmationDue(profile, asOf = new Date()) {
  if (profile.confirmationStatus === 'Confirmed') return false;
  const due = effectiveDueDate(profile);
  if (!due || Number.isNaN(due.getTime())) return false;
  return Math.ceil((due.getTime() - asOf.getTime()) / MS_PER_DAY) <= DUE_WINDOW_DAYS;
}

/**
 * How many confirmations are due for this admin — for the sidebar badge.
 *
 * Reads the rows rather than counting them, because the due date is computed
 * (see above). Four small fields over the people this admin may see, which is
 * the same wall and the same collection the list itself uses.
 * @param {import('express').Request} req
 * @returns {Promise<number>}
 */
async function countDueConfirmations(req) {
  const profiles = await EmployeeProfile
    .find({ ...employeeProfileScope(req), confirmationStatus: { $ne: 'Confirmed' } })
    .select('confirmationStatus confirmationDueDate dateOfJoining probationMonths')
    .lean();
  const now = new Date();
  return profiles.filter((p) => isConfirmationDue(p, now)).length;
}

/**
 * List employees for confirmation tracking with their effective due date.
 * @route GET /api/lifecycle/confirmations
 * @param {string} [req.query.status] - Probation|Extended|Confirmed
 * @returns {{count: number, items: Object[]}} sorted by dueDate (nulls last)
 */
// GET /api/lifecycle/confirmations  (?status=Probation|Extended|Confirmed)
const listConfirmations = asyncHandler(async (req, res) => {
  // Company wall: a walled admin only tracks confirmations of their own people.
  const filter = { ...employeeProfileScope(req) };
  if (req.query.status) filter.confirmationStatus = req.query.status;

  const profiles = await EmployeeProfile.find(filter).populate('user', USER_FIELDS);

  const items = profiles.map((p) => {
    const u = p.user || {};
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return {
      _id: p._id,
      employeeCode: p.employeeCode,
      name: name || u.email || '-',
      role: u.role,
      userId: u._id,
      designation: p.designation,
      department: p.department,
      dateOfJoining: p.dateOfJoining,
      probationMonths: p.probationMonths,
      confirmationStatus: p.confirmationStatus,
      dueDate: effectiveDueDate(p),
      // The server's verdict, so the row the table flags and the row the sidebar
      // badge counted are the same row. The table still works out the WORDING
      // ("3d overdue" / "in 12d") from dueDate itself.
      dueSoon: isConfirmationDue(p),
      confirmedOn: p.confirmedOn,
      confirmationNote: p.confirmationNote,
    };
  });

  // Sort by dueDate ascending; nulls last.
  items.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  res.json({ count: items.length, items });
});

/**
 * Confirm, extend, or reset an employee's probation.
 * @route PATCH /api/lifecycle/confirmations/:id  (:id = EmployeeProfile _id)
 * @param {string} req.params.id - EmployeeProfile id
 * @param {string} req.body.action - 'confirm' | 'extend' | 'reset'
 * @param {string} [req.body.note]
 * @param {number} [req.body.probationMonths]
 * @param {string} [req.body.confirmationDueDate] - explicit due date for 'extend' (else +3 months)
 * @returns {{profile: Object}}
 */
// PATCH /api/lifecycle/confirmations/:id  (:id = EmployeeProfile _id)
// body { action: 'confirm'|'extend'|'reset', note, probationMonths?, confirmationDueDate? }
const updateConfirmation = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id);
  // Company wall: 404 for another company's employee (existence stays hidden).
  if (!profile || cannotManageProfile(req, profile)) {
    res.status(404);
    throw new Error('Employee profile not found');
  }

  // Confirming or extending a Manager's probation is a change to a Manager's
  // record, so it needs the same grant editing their profile does.
  await assertCanEditProfileOf(req, profile);

  const { action, note, probationMonths, confirmationDueDate } = req.body;

  if (probationMonths != null) profile.probationMonths = probationMonths;

  switch (action) {
    case 'confirm':
      profile.confirmationStatus = 'Confirmed';
      profile.confirmedOn = new Date();
      break;
    case 'extend':
      profile.confirmationStatus = 'Extended';
      if (confirmationDueDate) {
        profile.confirmationDueDate = new Date(confirmationDueDate);
      } else {
        // Push due date by 3 months from current effective due date.
        const current = effectiveDueDate(profile) || new Date();
        profile.confirmationDueDate = addMonths(current, 3);
      }
      profile.confirmedOn = undefined;
      break;
    case 'reset':
      profile.confirmationStatus = 'Probation';
      profile.confirmedOn = undefined;
      break;
    default:
      res.status(400);
      throw new Error("action must be one of 'confirm', 'extend', 'reset'");
  }

  if (note != null) profile.confirmationNote = note;

  await profile.save();

  // Confirmation paperwork is set from a saved task template rather than
  // raised automatically — the event hook went with the 2026-09-21 task
  // rework (see employeeController.createEmployee).

  res.json({ profile });
});

// Suggest the next employee code from existing codes (most-common prefix wins,
// fallback 'EMP'). Reusable from other modules (e.g. candidate → employee).
async function computeNextEmployeeCode() {
  const profiles = await EmployeeProfile.find({}, 'employeeCode').lean();
  // Codes allotted on an appointment letter but not yet an employee. Without
  // these, two letters issued in the same week both suggest the same code: the
  // first candidate has no EmployeeProfile until they actually join, so nothing
  // here would know their code was spoken for. Shaped like a profile row so the
  // scanner below needs no special case.
  const reserved = (await reservedAppointmentCodes()).map((employeeCode) => ({ employeeCode }));

  // prefix + optional separator (space / dash) + digits, e.g. "SSL 1", "EMP-001", "EMP007".
  const CODE_RE = /^([A-Za-z]+)([\s-]*)(\d+)$/;
  // prefix -> { count, max, sep, width } — sep & width copied from the highest-numbered code
  // so the next suggestion keeps the exact style already in use (e.g. "SSL 8" -> "SSL 9").
  const stats = {};

  for (const p of [...profiles, ...reserved]) {
    if (!p.employeeCode) continue;
    const m = CODE_RE.exec(p.employeeCode.trim());
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const sep = m[2];
    const digits = m[3];
    const num = parseInt(digits, 10);

    const s = stats[prefix] || (stats[prefix] = { count: 0, max: -1, sep: ' ', width: 1 });
    s.count += 1;
    if (num >= s.max) { s.max = num; s.sep = sep; s.width = digits.length; }
  }

  // Most common prefix wins; fallback to 'SSL ' when there are no codes yet.
  let prefix = null;
  let best = null;
  for (const [pfx, s] of Object.entries(stats)) {
    if (!best || s.count > best.count) { best = s; prefix = pfx; }
  }

  if (!best) return { suggestion: 'SSL 1', prefix: 'SSL', next: 1 };

  const next = best.max + 1;
  const suggestion = prefix + best.sep + String(next).padStart(best.width, '0');
  return { suggestion, prefix, next };
}

/**
 * Suggest the next employee code (delegates to computeNextEmployeeCode).
 * @route GET /api/lifecycle/next-code
 * @returns {{suggestion: string, prefix: string, next: number}}
 */
// GET /api/lifecycle/next-code
const nextEmployeeCode = asyncHandler(async (req, res) => {
  res.json(await computeNextEmployeeCode());
});

module.exports = {
  listConfirmations,
  updateConfirmation,
  nextEmployeeCode,
  computeNextEmployeeCode,
  countDueConfirmations,
  DUE_WINDOW_DAYS,
};
