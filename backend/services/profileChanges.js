/**
 * Shared mechanics for the profile change-request workflow — used by both the
 * change-request controller (employee- and HR-raised requests) and the employee
 * controller (Backend direct edits). One place for: reading/formatting a
 * catalogue field, writing an approved value onto the User/EmployeeProfile,
 * deciding who approves (HR partner vs the employee's company CEO/MD), and
 * recording a field change in the audit log.
 */
const ChangeRequest = require('../models/ChangeRequest');
const { FIELD_CATALOG } = require('../models/ChangeRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { activeAccountWithEmail } = require('../utils/loginIdentity');
const AuditLog = require('../models/AuditLog');

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

/**
 * Who decides an HR-raised request: a CEO/MD who covers the employee's company
 * (an exec with that company in their list, or an unrestricted exec), else any
 * active CEO/MD, else a SuperAdmin.
 */
async function resolveExecAssignee(targetUserId) {
  const profile = await EmployeeProfile.findOne({ user: targetUserId }).select('company');
  const companyId = profile?.company ? String(profile.company) : '';
  const execs = await User.find({ role: { $in: ['CEO', 'MD'] }, isActive: true })
    .select('companies')
    .sort({ createdAt: 1 });
  if (companyId) {
    // An exec covers this company if they have it listed, or have no restriction.
    const covering = execs.find((e) => {
      const list = Array.isArray(e.companies) ? e.companies.map(String) : [];
      return list.length === 0 || list.includes(companyId);
    });
    if (covering) return covering._id;
  }
  if (execs.length) return execs[0]._id;
  const sa = await findSuperAdmin();
  return sa?._id;
}

/**
 * Record a single field change in the audit log (best-effort). Used for Backend
 * direct edits and to leave a trail when an approved request is applied.
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
  FIELD_CATALOG,
  getPath,
  fmtVal,
  isEmptyValue,
  readFieldValue,
  applyFieldValue,
  resolveHrAssignee,
  resolveExecAssignee,
  auditFieldChange,
  ChangeRequest,
};
