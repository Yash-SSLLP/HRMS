/**
 * Who a module may offer as "a person" — and who "everybody" means.
 *
 * Several modules need the same answer: the people this caller may act on.
 * It is never simply "every User" — three rules always apply, and each of them
 * has been forgotten somewhere at least once:
 *
 *   1. Only ACTIVE accounts. A deactivated login is nobody's assignee.
 *   2. No system logins. SuperAdmin and the God audit account are hidden from
 *      everyone but a SuperAdmin (utils/visibility HIDDEN_ROLES) — an audit
 *      account listed in a directory invites exactly the questions it exists
 *      to avoid.
 *   3. No executives, unless a SuperAdmin has opted them in
 *      (Settings → includeExecutivesInLists).
 *
 * …and then the company wall narrows it to the caller's own company.
 *
 * This is the filter, not the query: callers pick their own projection and
 * sort. It deliberately does NOT answer the "has this person left" question —
 * a resignation keeps the login active through the notice period, so that is
 * decided per row from `dateOfExit` (see utils/peopleOptions on the clients).
 */
const { hideSuperAdminFilter, shouldExcludeExecutives } = require('./visibility');
const { scopeUserFilter } = require('./employeeScope');
const { departedUserIdSet } = require('./departed');
const User = require('../models/User');

/**
 * Build the User filter for a people picker (or for "assign to everyone").
 * @param {import('express').Request} req - needs `req.user`
 * @param {Object} [extra] - extra constraints merged in first (e.g. {role: 'Employee'})
 * @returns {Promise<Object>} a mongo filter for User.find
 */
async function pickableUserFilter(req, extra = {}) {
  const filter = { isActive: true, ...extra };

  // Role exclusions are merged rather than assigned: `extra` may carry its own
  // $nin, and hideSuperAdminFilter would otherwise overwrite it — silently
  // widening the query to the very accounts a caller asked to leave out.
  const excluded = [];
  const hidden = hideSuperAdminFilter(req.user).role?.$nin;
  if (hidden) excluded.push(...hidden);
  if (await shouldExcludeExecutives(req)) excluded.push('CEO', 'MD');
  if (excluded.length) {
    // A plain string role is an EQUALITY constraint; keep it as one ({$eq})
    // instead of letting the spread drop it on the floor.
    const current = typeof filter.role === 'string' ? { $eq: filter.role }
      : (filter.role && typeof filter.role === 'object' ? filter.role : {});
    filter.role = {
      ...current,
      $nin: [...new Set([...(current.$nin || []), ...excluded])],
    };
  }

  // Company wall last: it constrains _id, so it composes with anything above.
  await scopeUserFilter(req, filter);
  return filter;
}

/**
 * The people themselves — the filter above, run, with anyone who has LEFT
 * dropped.
 *
 * The extra step matters because "left" is not a filter: a resignation keeps
 * the login active through the notice period, so it takes the exit date on the
 * employee profile to answer (utils/departed). Use this wherever the server
 * acts on "everybody" — handing a new task to somebody working out their last
 * fortnight is exactly what the portal-wide rule exists to prevent. A picker
 * that hands the list to a client can use pickableUserFilter instead and let
 * the client apply the same rule per row (it needs to keep a already-saved
 * leaver visible, which this cannot).
 * @param {import('express').Request} req
 * @param {Object} [opts]
 * @param {Object} [opts.extra] - extra filter constraints
 * @param {string} [opts.select] - projection (default just the id)
 * @returns {Promise<Object[]>} lean User rows
 */
async function pickablePeople(req, { extra = {}, select = '_id' } = {}) {
  const rows = await User.find(await pickableUserFilter(req, extra)).select(select).lean();
  const gone = await departedUserIdSet(rows.map((u) => u._id));
  return rows.filter((u) => !gone.has(String(u._id)));
}

module.exports = { pickableUserFilter, pickablePeople };
