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

// Executive roles kept out of "select an employee" pickers by default. They are
// still fully visible in user management, the org chart, and manager/approver
// selectors — only the opt-in pickers hide them.
const EXECUTIVE_ROLES = ['CEO', 'MD'];

// True when a picker that opted into executive exclusion (?excludeExecutives=true)
// should actually hide CEO/MD — i.e. the SuperAdmin toggle is off (the default).
async function shouldExcludeExecutives(req) {
  if (!req || req.query.excludeExecutives !== 'true') return false;
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  return !s.includeExecutivesInLists;
}

// User _ids of the executive accounts (CEO/MD), for excluding from profile-based
// listings populated by user (e.g. EmployeeProfile).
async function executiveUserIds() {
  return User.find({ role: { $in: EXECUTIVE_ROLES } }).distinct('_id');
}

module.exports = {
  hideSuperAdminFilter,
  hiddenUserIds,
  EXECUTIVE_ROLES,
  shouldExcludeExecutives,
  executiveUserIds,
};
