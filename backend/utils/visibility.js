const User = require('../models/User');

/**
 * People-visibility rules. SuperAdmin accounts are hidden from every non-SuperAdmin
 * viewer wherever people are listed; a SuperAdmin sees everyone.
 */

// Mongo filter fragment for User queries. Merge into the query's filter object.
const hideSuperAdminFilter = (viewer) =>
  viewer && viewer.role === 'SuperAdmin' ? {} : { role: { $ne: 'SuperAdmin' } };

// User _ids to exclude from profile/relationship-based listings (e.g. EmployeeProfile
// populated by user). Returns [] when the viewer is a SuperAdmin.
async function hiddenUserIds(viewer) {
  if (viewer && viewer.role === 'SuperAdmin') return [];
  return User.find({ role: 'SuperAdmin' }).distinct('_id');
}

module.exports = { hideSuperAdminFilter, hiddenUserIds };
