/**
 * Shared mechanics for the profile change-request workflow — used by both the
 * change-request controller (employee-raised requests) and the employee/admin
 * controllers (direct edits by HR, the Backend and an edit-mode CEO/MD). One
 * place for: reading/formatting a catalogue field, writing an approved value
 * onto the User/EmployeeProfile, deciding who approves an employee's request
 * (their HR partner), recording a field change in the audit log, and telling
 * the CEO/MD what HR changed.
 */
const ChangeRequest = require('../models/ChangeRequest');
const { FIELD_CATALOG } = require('../models/ChangeRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { activeAccountWithEmail } = require('../utils/loginIdentity');
const AuditLog = require('../models/AuditLog');
const { usersInRoles, scopeRecipientsToCompany } = require('./audience');
const { notifyMany } = require('./notify');

// Read a dot-path value off a doc / plain object.
function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// Stringify a catalogue value for display / snapshot. Dates render as YYYY-MM-DD.
function fmtVal(meta, val) {
  if (val == null) return '';
  if (meta.type === 'date') {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? String(val) : d.toISOString().slice(0, 10);
  }
  return String(val);
}

// Is a formatted value effectively empty (so the employee may fill it directly)?
const isEmptyValue = (v) => v == null || String(v).trim() === '';

/**
 * The current formatted value of one catalogue field for a given employee (by
 * their User id). Secret fields always read back empty.
 */
/**
 * Claim today's direct change of one field for one person.
 *
 * The insert IS the lock: the unique (user, field, day) index means two racing
 * requests cannot both win, and the loser sees a duplicate key. Anything other
 * than a duplicate is a real database problem and is re-thrown rather than
 * quietly granting the edit.
 *
 * Lives here rather than in the change-request controller because it is not that
 * controller's rule: the self-service birthday endpoint spends the same
 * allowance, and two copies of "have they already changed this today" is exactly
 * how a second, wider door gets built by accident.
 * @param {string} userId
 * @param {string} field - FIELD_CATALOG key
 * @returns {Promise<boolean>} true if today's allowance was still unspent
 */
async function claimDailySelfEdit(userId, field) {
  const SelfEditLog = require('../models/SelfEditLog');
  const { ymdIST } = require('../utils/dateHelpers');
  try {
    await SelfEditLog.create({ user: userId, field, day: ymdIST() });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // already used today
    throw err;
  }
}

/**
 * Hand back a claim whose edit did not go through — a rejected enum value, say.
 * Charging somebody a day for a change that errored would be its own small bug.
 */
function releaseDailySelfEdit(userId, field) {
  const SelfEditLog = require('../models/SelfEditLog');
  const { ymdIST } = require('../utils/dateHelpers');
  return SelfEditLog.deleteOne({ user: userId, field, day: ymdIST() }).catch(() => {});
}

async function readFieldValue(targetUserId, meta) {
  if (meta.secret) return '';
  if (meta.model === 'User') {
    const user = await User.findById(targetUserId).select(meta.path);
    return fmtVal(meta, user ? getPath(user, meta.path) : undefined);
  }
  const profile = await EmployeeProfile.findOne({ user: targetUserId }).lean();
  return fmtVal(meta, profile ? getPath(profile, meta.path) : undefined);
}

/**
 * Apply a value onto the target employee's underlying record. Runs schema
 * validators via save() (email format, IFSC, PAN, …). Throws with .status on
 * a bad target or an email clash.
 */
async function applyFieldValue(targetUserId, meta, value) {
  if (meta.model === 'User') {
    const user = await User.findById(targetUserId).select('+password');
    if (!user) throw Object.assign(new Error('Target user no longer exists'), { status: 404 });
    if (meta.path === 'email') {
      const email = String(value).toLowerCase().trim();
      const clash = await activeAccountWithEmail(email, user._id);
      if (clash) throw Object.assign(new Error('That email is already in use'), { status: 409 });
      user.email = email;
    } else {
      user.set(meta.path, value); // a password set here is re-hashed by the pre-save hook
    }
    await user.save();
  } else {
    const profile = await EmployeeProfile.findOne({ user: targetUserId });
    if (!profile) throw Object.assign(new Error('Employee profile not found'), { status: 404 });
    profile.set(meta.path, value);
    await profile.save();
  }
}

// Oldest active SuperAdmin — the universal fallback approver.
function findSuperAdmin() {
  return User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 });
}

/**
 * Who decides an EMPLOYEE-raised request: the employee's HR partner, else a
 * SuperAdmin.
 */
async function resolveHrAssignee(targetUserId) {
  const profile = await EmployeeProfile.findOne({ user: targetUserId }).select('hrPartner');
  if (profile?.hrPartner) return profile.hrPartner;
  const sa = await findSuperAdmin();
  return sa?._id;
}

// Statutory IDs and the bank account number never travel in full inside a
// notification: it is pushed to a phone and shows on the lock screen. The last
// four characters are enough to recognise the change; the record has the rest.
const MASKED_IN_NOTICES = new Set([
  'aadhaar', 'pan', 'uan', 'pfNumber', 'esicNumber', 'bankDetails.accountNumber',
]);
// A notice names at most this many changes, then says how many more there were.
const MAX_CHANGES_IN_NOTICE = 6;

// One value as a notice may show it: masked when sensitive, shortened when long.
function noticeValue(key, meta, value) {
  if (meta.secret) return '••••••';
  const s = value == null ? '' : String(value).trim();
  if (!s) return '';
  if (MASKED_IN_NOTICES.has(key)) return s.length > 4 ? `••${s.slice(-4)}` : '••••';
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

// "Department: Sales & Marketing → Sales", or "set to" / "cleared" at the edges.
function describeChange({ key, meta, from, to }) {
  const before = noticeValue(key, meta, from);
  const after = noticeValue(key, meta, to);
  if (!before) return `${meta.label} set to ${after}`;
  if (!after) return `${meta.label} cleared (was ${before})`;
  return `${meta.label}: ${before} → ${after}`;
}

/**
 * Tell the CEO/MD that HR changed an employee's details.
 *
 * HR's edits to an employee's record used to wait in the CEO/MD's Change
 * Requests inbox. Since 2026-09-26 they apply at once, and this is what replaced
 * the approval: the executives are TOLD, with the before and after of every
 * field, so nothing changes behind their back. It is informational only — there
 * is nothing to approve, and the notice says so.
 *
 * Recipients are the CEO/MD whose company scope covers the employee (the same
 * wall every other fan-out uses); with none, the Backend hears instead, as it
 * would have been the approver of last resort. One notice per save, however
 * many fields changed. Best-effort in the strongest sense: it swallows its own
 * errors, because the edit it reports has already been saved.
 *
 * @param {object} actor - req.user, the person who made the change
 * @param {string|import('mongoose').Types.ObjectId} targetUserId - the employee's User id
 * @param {Array<{key: string, meta: object, from: string, to: string}>} changes
 * @returns {Promise<{created: number}>} how many people were told
 */
async function notifyExecsOfHrChanges(actor, targetUserId, changes) {
  try {
    const list = (changes || []).filter((c) => c?.meta && String(c.from ?? '') !== String(c.to ?? ''));
    if (!targetUserId || !list.length) return { created: 0 };

    const [user, profile] = await Promise.all([
      User.findById(targetUserId).select('firstName lastName').lean(),
      EmployeeProfile.findOne({ user: targetUserId }).select('_id company').lean(),
    ]);
    let recipients = await scopeRecipientsToCompany(await usersInRoles('CEO', 'MD'), profile?.company);
    if (!recipients.length) recipients = await usersInRoles('SuperAdmin');
    recipients = recipients.filter((id) => String(id) !== String(actor?._id));
    if (!recipients.length) return { created: 0 };

    const who = `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim() || 'HR';
    const whose = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'an employee';
    const shown = list.slice(0, MAX_CHANGES_IN_NOTICE).map(describeChange);
    const more = list.length - shown.length;
    return await notifyMany(recipients, {
      // Not 'change_request': the app routes that type to the tapper's OWN
      // change-request screen, which is the wrong place for this.
      type: 'profile_update',
      audience: 'admin',
      title: `${who}${actor?.role === 'HRManager' ? ' (HR)' : ''} updated ${whose}'s details`,
      body: `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}. `
        + 'Already saved — this is for your information, nothing needs approving.',
      link: profile?._id ? `/admin/employees/${profile._id}` : '/admin/employees',
    });
  } catch (err) {
    console.error('HR-change notice to CEO/MD failed:', err.message);
    return { created: 0 };
  }
}

/**
 * Record a single field change in the audit log (best-effort). Used for every
 * direct edit from the admin side (HR, the Backend, an edit-mode CEO/MD) and to
 * leave a trail when an approved request is applied.
 * @param {object} actor - req.user (the person making the change)
 * @param {object} meta - FIELD_CATALOG entry
 * @param {string} from - previous formatted value
 * @param {string} to - new formatted value
 * @param {object} target - { name, profileId } of the employee changed
 */
function auditFieldChange(actor, meta, from, to, target = {}) {
  if (String(from ?? '') === String(to ?? '')) return;
  const redact = (v) => (meta.secret ? '••••••' : (v == null ? '' : String(v)));
  AuditLog.create({
    entity: 'EmployeeProfile',
    entityId: target.profileId,
    entityLabel: target.name,
    field: meta.label,
    fromStatus: redact(from),
    toStatus: redact(to),
    by: actor?._id,
    byName: actor?.fullName || `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim(),
    byRole: actor?.role,
    at: new Date(),
  }).catch(() => {});
}

module.exports = {
  claimDailySelfEdit,
  releaseDailySelfEdit,
  FIELD_CATALOG,
  getPath,
  fmtVal,
  isEmptyValue,
  readFieldValue,
  applyFieldValue,
  resolveHrAssignee,
  auditFieldChange,
  notifyExecsOfHrChanges,
  ChangeRequest,
};
