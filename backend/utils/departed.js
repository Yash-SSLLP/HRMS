/**
 * "Has this person left?" — one definition, for everywhere that has to answer it.
 *
 * TWO THINGS make somebody gone, and either alone is enough:
 *   · the login is deactivated (`User.isActive === false`) — what finalizeExit
 *     does on the last day, and what a Super Admin does by hand; or
 *   · their last working day has PASSED (`EmployeeProfile.dateOfExit <= today`)
 *     while the account is still live. That gap is deliberate: a resignation
 *     puts somebody on notice and their login keeps working through it (see the
 *     exit workflow), so `isActive` alone would still call them a colleague on
 *     the day after they walked out.
 *
 * This lived twice, copy-pasted, in chatController and khataController — which
 * is why the org chart and every people picker disagreed with chat about who
 * still worked here. It is one module now, and the answer travels to the
 * clients as well: `/api/admin/users` stamps `departed` on each row, and
 * `/api/employees` already carries `dateOfExit`, so a dropdown can apply the
 * same rule the server does.
 */
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

/**
 * Which of these accounts have left.
 * @param {Array<*>} userIds - User ids (any mix of ObjectId/string)
 * @returns {Promise<Set<string>>} the ids that have gone, as strings
 */
async function departedUserIdSet(userIds) {
  const ids = [...new Set((userIds || []).map(String))].filter(Boolean);
  if (!ids.length) return new Set();
  const departed = new Set();
  const [inactive, profiles] = await Promise.all([
    User.find({ _id: { $in: ids }, isActive: false }).select('_id').lean(),
    EmployeeProfile.find({ user: { $in: ids }, dateOfExit: { $ne: null, $lte: new Date() } })
      .select('user').lean(),
  ]);
  inactive.forEach((u) => departed.add(String(u._id)));
  profiles.forEach((p) => departed.add(String(p.user)));
  return departed;
}

/**
 * The same answer for one already-loaded pair, with no query.
 * @param {Object|null} user - a User (needs `isActive`)
 * @param {Object|null} profile - their EmployeeProfile (needs `dateOfExit`)
 * @returns {boolean}
 */
function hasDeparted(user, profile) {
  if (user && user.isActive === false) return true;
  const exit = profile && profile.dateOfExit;
  return !!exit && new Date(exit) <= new Date();
}

/** Mongo fragment for "their last day has passed", for composing into a query. */
const EXITED_FILTER = { dateOfExit: { $ne: null, $lte: new Date() } };

module.exports = { departedUserIdSet, hasDeparted, EXITED_FILTER };
