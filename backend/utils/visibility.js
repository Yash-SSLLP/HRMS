// People-visibility helpers. Central place for the rules that hide SuperAdmin
// accounts from non-SuperAdmins everywhere people are listed, and that keep
// executives (CEO/MD) out of opt-in "select an employee" pickers.
const User = require('../models/User');

/**
 * People-visibility rules. SuperAdmin accounts are hidden from every non-SuperAdmin
 * viewer wherever people are listed; a SuperAdmin sees everyone.
 */

/**
 * Mongo filter fragment for User queries — merge into the query's filter object.
 * @param {object|null} viewer - The requesting user (checked for role).
 * @returns {object} `{}` for a SuperAdmin viewer, else `{ role: { $ne: 'SuperAdmin' } }`.
 */
// Mongo filter fragment for User queries. Merge into the query's filter object.
const hideSuperAdminFilter = (viewer) =>
  viewer && viewer.role === 'SuperAdmin' ? {} : { role: { $ne: 'SuperAdmin' } };

/**
 * SuperAdmin User _ids to exclude from profile/relationship-based listings
 * (e.g. EmployeeProfile populated by user), where a Mongo filter fragment can't
 * be applied directly.
 * @param {object|null} viewer - The requesting user.
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} Ids to exclude; [] for a SuperAdmin viewer.
 */
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

/**
 * Whether a picker that opted into executive exclusion should hide CEO/MD.
 * Requires the request to carry `?excludeExecutives=true` AND the global
 * `includeExecutivesInLists` Setting to be off (the default).
 * @param {import('express').Request} req
 * @returns {Promise<boolean>} True to hide executives from this picker.
 */
// True when a picker that opted into executive exclusion (?excludeExecutives=true)
// should actually hide CEO/MD — i.e. the SuperAdmin toggle is off (the default).
async function shouldExcludeExecutives(req) {
  if (!req || req.query.excludeExecutives !== 'true') return false;
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  return !s.includeExecutivesInLists;
}

/**
 * @returns {Promise<import('mongoose').Types.ObjectId[]>} User _ids of the
 *   executive accounts (CEO/MD), for excluding from profile-based listings.
 */
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
