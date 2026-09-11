/**
 * Recipient lookup for capability-scoped notifications.
 *
 * "Who should hear about this?" is a permission question, and those rules already
 * live in one place — authMiddleware's hasPermission, which folds in role, the
 * HRManager `permissions` tri-state (undefined = ALL), the standalone
 * cashbookAccess flag, and execs switched into edit mode. Re-expressing all that
 * as a Mongo query would duplicate the rules and drift from them, so we project
 * only the fields hasPermission reads and filter in memory. The candidate set is
 * staff-sized and the projection keeps the scan cheap.
 */
const User = require('../models/User');
const { hasPermission } = require('../middleware/authMiddleware');

// The fields hasPermission consults — extend if its rules grow.
// Every standalone grant flag hasPermission() reads has to be SELECTED here,
// or the holder silently drops out of every fan-out that asks for their
// capability — the query says they don't hold it because the field is absent.
const PERMISSION_FIELDS = '_id role permissions cashbookAccess expensesAccess assetsAccess khataAccess loansAccess execEditAccess';

/**
 * Ids of every active user holding AT LEAST ONE of the given capabilities.
 * @param {...string} caps - Capability keys from config/permissions.js.
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} Matching user ids.
 */
async function usersHoldingAny(...caps) {
  const users = await User.find({ isActive: true }).select(PERMISSION_FIELDS).lean();
  return users.filter((u) => caps.some((cap) => hasPermission(u, cap))).map((u) => u._id);
}

/**
 * Ids of every active user holding one of the given ROLES.
 *
 * The role-keyed twin of usersHoldingAny, for the handful of decisions that are
 * a role's to make rather than a capability's — sanctioning a cash advance, or a
 * payslip its own subject wrote. Those deliberately do not route through
 * hasPermission (see authMiddleware's canApproveSelfPayslip), so neither can the
 * notification that tells the bench something is waiting on them: asking for
 * `payroll.manage` here would tell the HR Manager whose slip it is.
 * @param {...string} roles - User.role values.
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} Matching user ids.
 */
async function usersInRoles(...roles) {
  const users = await User.find({ isActive: true, role: { $in: roles } }).select('_id').lean();
  return users.map((u) => u._id);
}

/**
 * Company wall for notification fan-outs: keep only the recipients whose own
 * scope covers the given company. Without this, "tell everyone who manages
 * leave" told company B's HR about company A's people.
 *
 * A recipient covers the company when they are the Backend (SuperAdmin), a
 * CEO/MD whose `companies` list is empty or names it, or anyone else whose own
 * EmployeeProfile.company is unset or matches — the same rules the read paths
 * enforce (utils/employeeScope.js), applied from the record's side.
 * @param {Array} recipientIds - candidate User ids
 * @param {*} companyId - the subject employee's company (falsy = visible to all)
 * @returns {Promise<Array>} the ids that survive the wall
 */
async function scopeRecipientsToCompany(recipientIds, companyId) {
  const ids = (recipientIds || []).filter(Boolean);
  if (!companyId || !ids.length) return ids;
  const cid = String(companyId);
  const users = await User.find({ _id: { $in: ids } }).select('role companies').lean();
  const EmployeeProfile = require('../models/EmployeeProfile');
  const profByUser = new Map(
    (await EmployeeProfile.find({ user: { $in: ids } }).select('user company').lean())
      .map((p) => [String(p.user), p.company ? String(p.company) : ''])
  );
  return users
    .filter((u) => {
      if (u.role === 'SuperAdmin') return true;
      if (['CEO', 'MD'].includes(u.role)) {
        const own = Array.isArray(u.companies) ? u.companies.filter(Boolean).map(String) : [];
        return own.length === 0 || own.includes(cid);
      }
      const own = profByUser.get(String(u._id)) || '';
      return !own || own === cid;
    })
    .map((u) => u._id);
}

module.exports = { usersHoldingAny, usersInRoles, scopeRecipientsToCompany };
