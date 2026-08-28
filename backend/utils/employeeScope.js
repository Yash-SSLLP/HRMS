/**
 * Shared employee-visibility scope. One source of truth for "which employees may
 * this admin see and manage", used by the employee directory and — so the rule
 * is enforced everywhere, not just there — by attendance, payroll, the org
 * chart, celebrations, the chat directory and the user list.
 *
 * The rules:
 *   Backend (SuperAdmin)     → every employee, every company.
 *   CEO / MD                 → the companies assigned to them (User.companies);
 *                              with none set they are unrestricted.
 *   HR Manager               → employees whose hrPartner is them, AND inside
 *                              their own company (see below).
 *   every other role         → their own company only.
 *
 * COMPANY WALL. Everyone except the Backend is confined to their own company:
 * an exec's companies come from `User.companies`; everyone else's single
 * company is their own EmployeeProfile.company, resolved once per request by
 * the auth middleware and stashed on `req.user.scopeCompanyId`. An account
 * whose own profile has no company set is unrestricted (backward compatible —
 * the walls go up as companies are assigned). Non-exec viewers also see
 * employees with NO company set (those belong to nobody else's company);
 * a narrowed exec deliberately does not (see orgController's rationale).
 *
 * See models/EmployeeProfile.js (`company`, `hrPartner`) and models/User.js
 * (`companies`). The employee controller keeps thin wrappers around these.
 */
const mongoose = require('mongoose');
const EmployeeProfile = require('../models/EmployeeProfile');
const { EXECUTIVE_ROLES } = require('./visibility');

/**
 * The companies this viewer may see people of.
 * @param {import('express').Request} req
 * @returns {{ids: string[], includeUnassigned: boolean}|null}
 *   null = unrestricted; otherwise the allowed company ids and whether
 *   no-company employees are visible too.
 */
function viewerCompanyScope(req) {
  const u = req && req.user;
  if (!u || u.role === 'SuperAdmin') return null;
  if (EXECUTIVE_ROLES.includes(u.role)) {
    const ids = Array.isArray(u.companies) ? u.companies.filter(Boolean).map(String) : [];
    if (!ids.length) return null; // unrestricted exec
    return { ids, includeUnassigned: false };
  }
  // Everyone else: their own profile's company (stashed by the auth middleware).
  const own = u.scopeCompanyId ? String(u.scopeCompanyId) : '';
  if (!own) return null; // no company on their own profile → unrestricted
  return { ids: [own], includeUnassigned: true };
}

/**
 * Mongo filter fragment on `company` for EmployeeProfile queries. `{}` means
 * unrestricted. `$in` with null matches both null and missing, which is how
 * no-company employees stay visible to non-exec viewers.
 * @param {import('express').Request} req
 * @returns {Object}
 */
function companyScopeFilter(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return {};
  // Real ObjectIds, not the strings viewerCompanyScope keeps for comparisons:
  // this fragment is spread into aggregate() $match stages too (department
  // headcounts), and aggregation does no schema casting — hex strings would
  // silently match nothing there.
  const ids = scope.ids.map((id) => new mongoose.Types.ObjectId(id));
  const list = scope.includeUnassigned ? [...ids, null] : ids;
  return { company: { $in: list } };
}

/**
 * Per-record form of the company wall: is this profile's company outside what
 * the viewer may see?
 * @param {import('express').Request} req
 * @param {Object} profile - an EmployeeProfile (needs `company`)
 * @returns {boolean}
 */
function companyOutOfScope(req, profile) {
  const scope = viewerCompanyScope(req);
  if (!scope) return false;
  const cid = profile && profile.company ? String(profile.company._id || profile.company) : '';
  if (!cid) return !scope.includeUnassigned;
  return !scope.ids.includes(cid);
}

/**
 * The EmployeeProfile-level Mongo filter fragment for who this admin may see.
 * `{}` means unrestricted.
 * @param {import('express').Request} req
 * @returns {Object} a filter fragment to spread into an EmployeeProfile query
 */
function employeeProfileScope(req) {
  const u = req && req.user;
  if (!u || u.role === 'SuperAdmin') return {};
  if (u.role === 'HRManager') return { hrPartner: u._id, ...companyScopeFilter(req) };
  return { ...companyScopeFilter(req) };
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
  // Memoized per request: several handlers consult the scope more than once
  // (a list filter plus per-record guards), and the answer cannot change
  // mid-request. Stored as the promise so concurrent callers share one query.
  if (!req._allowedEmployeeIdsPromise) {
    req._allowedEmployeeIdsPromise = EmployeeProfile.find(filter).select('_id').lean()
      .then((rows) => rows.map((r) => r._id));
  }
  return req._allowedEmployeeIdsPromise;
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
  if (isIdValue(filter.employee)) {
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
    if (String(profile.hrPartner || '') !== String(u._id)) return true;
  }
  return companyOutOfScope(req, profile);
}

/**
 * The set of User ids whose PEOPLE-facing records this viewer may see, or null
 * when unrestricted. This is the User-keyed twin of allowedEmployeeIds, for
 * listings keyed by User rather than EmployeeProfile (chat directory, the
 * accounts list, celebrations' populated users).
 *
 * Included beyond the profile match: CEO/MD accounts whose own company list
 * covers (or does not exclude) the viewer's companies — executives have no
 * profile but still belong on company A's people surfaces when they cover
 * company A — and SuperAdmin accounts (their visibility is decided separately
 * by utils/visibility.hideSuperAdminFilter, not by the company wall).
 * @param {import('express').Request} req
 * @returns {Promise<string[]|null>} allowed User ids as strings, or null
 */
async function allowedUserIds(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return null;
  // Memoized per request (see allowedEmployeeIds): handlers like the khata
  // overview consult this several times, and each cold call costs two queries.
  if (!req._allowedUserIdsPromise) {
    const User = require('../models/User');
    const profFilter = companyScopeFilter(req);
    req._allowedUserIdsPromise = Promise.all([
      EmployeeProfile.find(profFilter).select('user').lean(),
      User.find({ role: { $in: ['SuperAdmin', ...EXECUTIVE_ROLES] } }).select('role companies').lean(),
      // Accounts with NO profile at all (a seeded AccountsManager, a profile
      // whose auto-create failed) belong to no company, so a non-exec viewer
      // — who sees unassigned people — must see them too. Resolved by
      // subtracting every profile-holding user from the full account list.
      scope.includeUnassigned
        ? Promise.all([
          // SuperAdmin/CEO/MD are decided by the account-scoped branch below,
          // never by profile absence — a narrowed exec must stay hidden.
          User.find({ role: { $nin: ['SuperAdmin', ...EXECUTIVE_ROLES] } }).select('_id').lean(),
          EmployeeProfile.find({}).select('user').lean(),
        ]).then(([allUsers, allProfiles]) => {
          const withProfile = new Set(allProfiles.filter((p) => p.user).map((p) => String(p.user)));
          return allUsers.map((u) => String(u._id)).filter((id) => !withProfile.has(id));
        })
        : Promise.resolve([]),
    ]).then(([profiles, accountOnly, profileless]) => {
      const ids = new Set(profiles.filter((p) => p.user).map((p) => String(p.user)));
      for (const u of accountOnly) {
        if (u.role === 'SuperAdmin') { ids.add(String(u._id)); continue; }
        const own = Array.isArray(u.companies) ? u.companies.filter(Boolean).map(String) : [];
        // An exec with no list spans every company; a narrowed exec shows up
        // only where their companies overlap the viewer's.
        if (own.length === 0 || own.some((c) => scope.ids.includes(c))) ids.add(String(u._id));
      }
      for (const id of profileless) ids.add(id);
      return [...ids];
    });
  }
  return req._allowedUserIdsPromise;
}

/**
 * Narrow a User-collection query filter to the accounts this viewer may see
 * (company wall only — SuperAdmin hiding stays with utils/visibility). Mutates
 * and returns the filter, honouring an existing `_id` constraint.
 * @param {import('express').Request} req
 * @param {Object} [filter]
 * @returns {Promise<Object>}
 */
// An id value passed as an equality constraint — a string, or an ObjectId
// (which is `typeof 'object'` but must NOT fall into the merge branch below,
// where its spread would silently widen the query to every allowed id).
const isIdValue = (v) => v != null
  && (typeof v !== 'object' || typeof v.toHexString === 'function');

async function scopeUserFilter(req, filter = {}) {
  const ids = await allowedUserIds(req);
  if (!ids) return filter;
  if (isIdValue(filter._id)) {
    const ok = ids.some((id) => id === String(filter._id));
    filter._id = ok ? filter._id : { $in: [] };
  } else if (filter._id && Array.isArray(filter._id.$in)) {
    filter._id.$in = filter._id.$in.filter((x) => ids.includes(String(x)));
  } else {
    filter._id = { ...(filter._id || {}), $in: ids };
  }
  return filter;
}

/**
 * Narrow a query filter whose given field holds a USER id (as on Expense,
 * Loan, Task.assignedTo, EmployeeWallet.employee …) to the users this viewer
 * may see. The User-keyed twin of scopeEmployeeFilter. Mutates and returns
 * the filter; unrestricted viewers are a no-op.
 * @param {import('express').Request} req
 * @param {Object} [filter]
 * @param {string} [field='employee'] - the filter key holding a User id
 * @returns {Promise<Object>}
 */
async function scopeUserField(req, filter = {}, field = 'employee') {
  const ids = await allowedUserIds(req);
  if (!ids) return filter;
  const cur = filter[field];
  if (isIdValue(cur)) {
    filter[field] = ids.includes(String(cur)) ? cur : { $in: [] };
  } else if (cur && Array.isArray(cur.$in)) {
    cur.$in = cur.$in.filter((x) => ids.includes(String(x)));
  } else {
    filter[field] = { ...(cur || {}), $in: ids };
  }
  return filter;
}

/**
 * Per-record guard for a record keyed by USER id: true when this viewer may
 * NOT see records belonging to that user.
 * @param {import('express').Request} req
 * @param {*} userId - the record owner's User id
 * @returns {Promise<boolean>}
 */
async function cannotSeeUser(req, userId) {
  const ids = await allowedUserIds(req);
  if (!ids) return false;
  return !ids.includes(String(userId));
}

/**
 * The companies a CEO/MD has been narrowed to, as strings.
 *
 * Separated from employeeProfileScope because some screens need ONLY this half
 * of the rule. Empty array = unrestricted (every company), matching
 * User.companies, where an absent or empty list deliberately means "all".
 * @param {object|null} user
 * @returns {string[]} company ids, or [] when this account is not narrowed
 */
function execCompanyIds(user) {
  if (!user || !EXECUTIVE_ROLES.includes(user.role)) return [];
  return Array.isArray(user.companies) ? user.companies.filter(Boolean).map(String) : [];
}

/**
 * The manager-profile grant, as a per-record guard.
 *
 * A `Manager` approves their own team's leave and signs off their attendance, so
 * their record — reporting line, department, salary, confirmation — is only
 * editable by an admin a SuperAdmin has explicitly trusted with it
 * (`User.managerProfileAccess`). This is the sync form, for callers that already
 * know the linked account's role; `assertCanEditProfileOf` below resolves the
 * role first.
 *
 * Deliberately separate from cannotManageProfile: that one answers "is this
 * person mine to look after at all" (HR partner, company wall) and applies to
 * reads as well. This applies only to WRITES, and only to managers.
 * @param {import('express').Request} req
 * @param {string} [role] - the linked account's role
 * @throws 403 via res-less Error with .status when the grant is missing
 */
function assertCanEditManagerProfile(req, role) {
  // Lazy require: authMiddleware is loaded by every route file, and pulling it
  // in at module init here would tangle the load order (see attachScopeCompany).
  const { canEditManagerProfiles, isManagerProfileRole } = require('../middleware/authMiddleware');
  if (!isManagerProfileRole(role)) return; // ordinary staff — nothing extra to check
  if (canEditManagerProfiles(req.user)) return;
  const err = new Error("You do not have permission to change a Manager's record. Ask a Super Admin to grant it.");
  err.status = 403;
  throw err;
}

/**
 * Same guard, for a profile whose linked account role has not been loaded. Uses
 * an already-populated `profile.user.role` when there is one, so a caller that
 * populated the user pays nothing extra.
 * @param {import('express').Request} req
 * @param {Object} profile - an EmployeeProfile (needs `user`)
 * @returns {Promise<void>}
 * @throws 403 (see assertCanEditManagerProfile)
 */
async function assertCanEditProfileOf(req, profile) {
  const linked = profile && profile.user;
  if (!linked) return; // no account behind this record — nothing to protect
  if (linked.role !== undefined) return assertCanEditManagerProfile(req, linked.role);
  const User = require('../models/User');
  const account = await User.findById(linked._id || linked).select('role').lean();
  return assertCanEditManagerProfile(req, account && account.role);
}

module.exports = {
  viewerCompanyScope,
  companyScopeFilter,
  companyOutOfScope,
  employeeProfileScope,
  isUnscoped,
  allowedEmployeeIds,
  scopeEmployeeFilter,
  cannotManageProfile,
  assertCanEditManagerProfile,
  assertCanEditProfileOf,
  allowedUserIds,
  scopeUserFilter,
  scopeUserField,
  cannotSeeUser,
  execCompanyIds,
};
