/**
 * Shared employee-visibility scope. One source of truth for "which employees may
 * this admin see and manage", used by the employee directory and — so the rule
 * is enforced everywhere, not just there — by attendance and payroll.
 *
 * The rules:
 *   Backend (SuperAdmin)     → every employee.
 *   HR Manager               → only employees whose hrPartner is them.
 *   CEO / MD                 → the companies assigned to them (User.companies);
 *                              with none set they are unrestricted.
 *   anyone else              → unrestricted here (their access is gated elsewhere).
 *
 * See models/EmployeeProfile.js (`company`, `hrPartner`) and models/User.js
 * (`companies`). The employee controller keeps thin wrappers around these.
 */
const EmployeeProfile = require('../models/EmployeeProfile');
const { EXECUTIVE_ROLES } = require('./visibility');

/**
 * The EmployeeProfile-level Mongo filter fragment for who this admin may see.
 * `{}` means unrestricted.
 * @param {import('express').Request} req
 * @returns {Object} a filter fragment to spread into an EmployeeProfile query
 */
function employeeProfileScope(req) {
  const u = req && req.user;
  if (!u || u.role === 'SuperAdmin') return {};
  if (u.role === 'HRManager') return { hrPartner: u._id };
  if (EXECUTIVE_ROLES.includes(u.role)) {
    const ids = Array.isArray(u.companies) ? u.companies.filter(Boolean) : [];
    if (ids.length) return { company: { $in: ids } };
    return {};
  }
  return {};
}

/**
 * True when this admin sees every employee (the Backend, or an unrestricted
 * exec) — lets callers skip the id lookup entirely.
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isUnscoped(req) {
  return Object.keys(employeeProfileScope(req)).length === 0;
}

/**
 * The set of EmployeeProfile ids this admin may see, or `null` when unrestricted.
 * Callers apply `{ employee: { $in: ids } }` on Attendance / Payroll / etc.
 * queries (whose `employee` is an EmployeeProfile id). Returning `null` rather
 * than "all ids" keeps the unrestricted path a no-op.
 * @param {import('express').Request} req
 * @returns {Promise<import('mongoose').Types.ObjectId[]|null>}
 */
async function allowedEmployeeIds(req) {
  const filter = employeeProfileScope(req);
  if (Object.keys(filter).length === 0) return null;
  const rows = await EmployeeProfile.find(filter).select('_id').lean();
  return rows.map((r) => r._id);
}

/**
 * Narrow a query filter whose `employee` field is an EmployeeProfile id (as on
 * Attendance and Payroll) to the records this admin may see. Returns the same
 * filter object, mutated:
 *   - unrestricted admin → unchanged;
 *   - a specific employee already requested → kept only if it is in scope,
 *     otherwise forced to match nothing;
 *   - otherwise → constrained to the admin's allowed employee ids.
 * @param {import('express').Request} req
 * @param {Object} [filter] - a Mongo filter that may already carry `employee`
 * @returns {Promise<Object>} the (possibly mutated) filter
 */
async function scopeEmployeeFilter(req, filter = {}) {
  const ids = await allowedEmployeeIds(req);
  if (!ids) return filter; // unrestricted
  if (filter.employee != null && typeof filter.employee !== 'object') {
    const ok = ids.some((id) => String(id) === String(filter.employee));
    filter.employee = ok ? filter.employee : { $in: [] };
  } else {
    filter.employee = { $in: ids };
  }
  return filter;
}

/**
 * Per-record guard: may this admin NOT view/manage this profile? The counterpart
 * of employeeProfileScope for a single already-loaded profile.
 * @param {import('express').Request} req
 * @param {Object} profile - an EmployeeProfile (needs hrPartner / company)
 * @returns {boolean}
 */
function cannotManageProfile(req, profile) {
  const u = req && req.user;
  if (!u || u.role === 'SuperAdmin') return false;
  if (!profile) return false;
  if (u.role === 'HRManager') {
    return String(profile.hrPartner || '') !== String(u._id);
  }
  if (EXECUTIVE_ROLES.includes(u.role)) {
    const ids = Array.isArray(u.companies) ? u.companies.map(String) : [];
    if (!ids.length) return false; // unrestricted exec
    return !ids.includes(String(profile.company || ''));
  }
  return false;
}

/**
 * The companies a CEO/MD has been narrowed to, as strings.
 *
 * Separated from employeeProfileScope because some screens need ONLY this half
 * of the rule. The org chart is the case in point: it is readable by everyone,
 * so applying the full scope would hand an HR Manager a chart containing only
 * their own assigned employees and shatter the reporting tree — but a
 * company-limited executive must still not see another company's people.
 *
 * Empty array = unrestricted (every company), matching User.companies, where an
 * absent or empty list deliberately means "all".
 * @param {object|null} user
 * @returns {string[]} company ids, or [] when this account is not narrowed
 */
function execCompanyIds(user) {
  if (!user || !EXECUTIVE_ROLES.includes(user.role)) return [];
  return Array.isArray(user.companies) ? user.companies.filter(Boolean).map(String) : [];
}

module.exports = {
  employeeProfileScope,
  isUnscoped,
  allowedEmployeeIds,
  scopeEmployeeFilter,
  cannotManageProfile,
  execCompanyIds,
};
