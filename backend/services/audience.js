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
const PERMISSION_FIELDS = '_id role permissions cashbookAccess expensesAccess assetsAccess execEditAccess';

/**
 * Ids of every active user holding AT LEAST ONE of the given capabilities.
 * @param {...string} caps - Capability keys from config/permissions.js.
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} Matching user ids.
 */
async function usersHoldingAny(...caps) {
  const users = await User.find({ isActive: true }).select(PERMISSION_FIELDS).lean();
  return users.filter((u) => caps.some((cap) => hasPermission(u, cap))).map((u) => u._id);
}

module.exports = { usersHoldingAny };
