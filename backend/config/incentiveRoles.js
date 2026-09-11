/**
 * Who does what inside the Incentive section, per tab.
 *
 * The section is built to hold several incentives — Boys today, Billing and
 * whatever else later — and each one is run by different people. So access is
 * not one switch but a ROLE PER TAB, chosen from this catalogue (user decision
 * 2026-09-10). `User.incentiveRoles` stores the assignments as
 * `[{ module, role }]`.
 *
 * THE TWO ROLES, and the line between them is the whole point:
 *
 *   manager — runs the tab. Sets what a point is worth and what a unit of work
 *             yields, records how much work was done, and corrects anything
 *             already saved (including somebody else's team).
 *   picker  — puts together their OWN team for the day and nothing else. They
 *             cannot enter the work done, cannot change the rates, and cannot
 *             edit a team once it is saved: a correction goes through the
 *             manager, which is what makes the day's record worth anything.
 *
 * `ALL_MODULES` ('all') is the section-wide assignment — a manager of every
 * incentive, present and future. It also carries ONE power no per-tab manager
 * has: crediting points to somebody directly, outside any team-day (see
 * canCreditIncentive in middleware/authMiddleware.js). The points pool is
 * company-wide, so awarding into it belongs to whoever runs the section rather
 * than to one tab's supervisor. HR, CEO, MD and SuperAdmin hold that by role and
 * are never listed here.
 *
 * Keep `key` values stable: they are stored on User documents.
 */

/** The pseudo-module meaning "every incentive tab". */
const ALL_MODULES = 'all';

const INCENTIVE_MODULES = [
  {
    key: ALL_MODULES,
    label: 'All incentives',
    hint: 'Runs every incentive tab, including ones added later, and can credit points to anybody on the Points Dashboard.',
    roles: ['manager'],
  },
  {
    key: 'boys',
    label: 'Boys Incentive',
    hint: 'The daily rolling teams.',
    roles: ['manager', 'picker'],
  },
];

const INCENTIVE_ROLES = [
  {
    key: 'manager',
    label: 'Manager',
    hint: 'Sets the point rate and the yield, records the work done, and corrects anything already saved.',
  },
  {
    key: 'picker',
    label: 'Picker',
    hint: 'Puts together their own team for the day. Cannot enter the work done, and cannot edit a team once saved.',
  },
];

const MODULE_KEYS = INCENTIVE_MODULES.map((m) => m.key);
const ROLE_KEYS = INCENTIVE_ROLES.map((r) => r.key);

/**
 * Is this a role this module actually offers? ('all' has no picker — a picker
 * belongs to one tab's daily work, not to the section.)
 * @param {string} moduleKey
 * @param {string} role
 * @returns {boolean}
 */
function isValidAssignment(moduleKey, role) {
  const mod = INCENTIVE_MODULES.find((m) => m.key === moduleKey);
  return !!mod && mod.roles.includes(role);
}

module.exports = {
  ALL_MODULES,
  INCENTIVE_MODULES,
  INCENTIVE_ROLES,
  MODULE_KEYS,
  ROLE_KEYS,
  isValidAssignment,
};
