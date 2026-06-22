const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { computeNextEmployeeCode } = require('../controllers/lifecycleController');

// Ensure a user has an EmployeeProfile so they're treated as an employee
// everywhere (employee list, org chart, attendance, leave, payslips). Idempotent.
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

// One-time backfill: give any existing active HR manager an employee profile.
// Runs on startup; idempotent.
async function backfillHrProfiles() {
  const hrs = await User.find({ role: 'HRManager', isActive: true });
  let created = 0;
  for (const u of hrs) {
    const existing = await EmployeeProfile.findOne({ user: u._id });
    if (existing) continue;
    try { await ensureEmployeeProfile(u); created += 1; } catch (err) { console.error('HR profile backfill failed for', u.email, '—', err.message); }
  }
  if (created) console.log(`Backfilled ${created} HR employee profile(s).`);
}

module.exports = { ensureEmployeeProfile, backfillHrProfiles };
