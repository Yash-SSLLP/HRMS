/**
 * Employee-profile provisioning helpers.
 *
 * Guarantees that users who should behave as employees actually have an
 * EmployeeProfile row (which drives the employee list, org chart, attendance,
 * leave, payslips, etc.). New codes come from lifecycleController.computeNextEmployeeCode.
 *
 * External systems: none. Reads/writes the EmployeeProfile and User collections.
 */
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { computeNextEmployeeCode } = require('../controllers/lifecycleController');

/**
 * Ensure a user has an EmployeeProfile so they're treated as an employee
 * everywhere (employee list, org chart, attendance, leave, payslips). Idempotent.
 * @param {Object} user - User doc (or lean object) with at least _id; may include createdAt.
 * @returns {Promise<Object|null>} The existing or newly created EmployeeProfile, or null when no user.
 * @sideEffects May insert an EmployeeProfile document (allocating a fresh employee code).
 */
async function ensureEmployeeProfile(user) {
  if (!user) return null;
  const existing = await EmployeeProfile.findOne({ user: user._id });
  if (existing) return existing;
  const { suggestion } = await computeNextEmployeeCode();
  return EmployeeProfile.create({
    user: user._id,
    employeeCode: suggestion,
    dateOfJoining: user.createdAt || new Date(),
  });
}

/**
 * One-time backfill: give any existing active HR manager / L&D admin an employee
 * profile. CEO/MD are intentionally excluded (they are not employees). Runs on
 * startup; idempotent.
 * @returns {Promise<void>}
 * @sideEffects Inserts EmployeeProfile documents for eligible users; logs a count.
 */
async function backfillHrProfiles() {
  const hrs = await User.find({ role: { $in: ['HRManager', 'LDManager', 'AccountsManager'] }, isActive: true });
  let created = 0;
  for (const u of hrs) {
    const existing = await EmployeeProfile.findOne({ user: u._id });
    if (existing) continue;
    try { await ensureEmployeeProfile(u); created += 1; } catch (err) { console.error('HR profile backfill failed for', u.email, '—', err.message); }
  }
  if (created) console.log(`Backfilled ${created} HR employee profile(s).`);
}

module.exports = { ensureEmployeeProfile, backfillHrProfiles };
