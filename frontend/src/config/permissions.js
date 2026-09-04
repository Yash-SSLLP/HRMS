// Client mirror of backend middleware `hasPermission` — used only to show/hide
// nav items and action buttons. The server is the real enforcement boundary.
//
// SuperAdmin → all. CEO/MD → all (read-only viewers still see every page).
// LDManager → only courses. HRManager → their `permissions` array, where a
// missing/undefined array means ALL (existing HRs keep full access).
// Manager → their `permissions` array ONLY; absent means none.

/**
 * Roles a SuperAdmin can grant individual capabilities to. Mirrors
 * GRANTABLE_ROLES in backend/config/permissions.js.
 */
export const GRANTABLE_ROLES = ['HRManager', 'Manager'];

export function hasPermission(user, cap) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  if (user.role === 'CEO' || user.role === 'MD') return true;
  // Cashbook and expense access are standalone grants an admin can give to any
  // user/employee, whatever their role.
  if (cap === 'cashbook.manage' && user.cashbookAccess === true) return true;
  if (cap === 'expenses.manage' && user.expensesAccess === true) return true;
  if (cap === 'assets.manage' && user.assetsAccess === true) return true;
  // Khata access is the same kind of standalone grant: it opens the employee
  // cash-ledger module for anyone. WHICH company account they may pay out of is
  // decided per account on the server (CashAccount.operators), not here.
  if (cap === 'khata.manage' && user.khataAccess === true) return true;
  if (user.role === 'LDManager') return cap === 'courses.manage';
  // Account Managers settle reimbursements out of the cashbook, so they hold the
  // expense capability alongside it.
  if (user.role === 'AccountsManager') {
    return cap === 'cashbook.manage' || cap === 'expenses.manage' || cap === 'khata.manage';
  }
  if (user.role === 'HRManager') {
    const p = user.permissions;
    if (p == null) return true; // undefined/null → all
    return Array.isArray(p) && p.includes(cap);
  }
  // Manager holds exactly what was granted — absent means none, unlike the
  // HRManager default above (see backend/config/permissions.js for why).
  if (user.role === 'Manager') {
    return Array.isArray(user.permissions) && user.permissions.includes(cap);
  }
  return false;
}

/**
 * Does this account hold `cap` because somebody TICKED IT, rather than because a
 * role default swept it in? Mirrors hasExplicitPermission in the backend's
 * authMiddleware — `hasPermission` answers an HR Manager with no permissions
 * array with "everything", which is the right default for a capability HR always
 * had and the wrong one for a capability being taken away from them.
 * @param {object|null} user
 * @param {string} cap
 * @returns {boolean}
 */
export function hasExplicitPermission(user, cap) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  if (isEditingExec(user)) return true;
  return Array.isArray(user.permissions) && user.permissions.includes(cap);
}

/**
 * May this account download the khata as a spreadsheet? Mirrors canExportKhata
 * in the backend's authMiddleware — and, like it, deliberately answers on the
 * flag alone rather than through hasPermission, so no role picks it up by
 * default. Opening the khata module does not include taking the data out of it.
 * @param {object|null} user
 * @returns {boolean}
 */
export const canExportKhata = (user) => !!user
  && (user.role === 'SuperAdmin' || user.khataExportAccess === true);

/**
 * Roles whose employee profile is protected by the manager-profile grant.
 * Mirrors MANAGER_PROFILE_ROLES in the backend's authMiddleware.
 */
export const MANAGER_PROFILE_ROLES = ['Manager'];

/** Is this the account role the manager-profile grant protects? */
export const isManagerProfileRole = (role) => MANAGER_PROFILE_ROLES.includes(role);

/**
 * May this account edit the employee profile of a Manager? Mirrors
 * canEditManagerProfiles in the backend's authMiddleware — and, like it,
 * answers on the explicit flag alone rather than through hasPermission, so no
 * role picks it up by default. Holding `employees.manage` is about ordinary
 * staff records; editing the people who approve their own team's leave is a
 * separate, named grant.
 * @param {object|null} user
 * @returns {boolean}
 */
export const canEditManagerProfiles = (user) => {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  if (isEditingExec(user)) return true;
  return user.managerProfileAccess === true;
};

/**
 * May this account edit THIS employee's profile? The role check above combined
 * with the target's account role, so a caller does not have to remember both.
 * @param {object|null} me - the signed-in user
 * @param {object|null} target - the linked account of the employee being edited
 *   (needs `role`), e.g. `profile.user`
 * @returns {boolean}
 */
export const canEditEmployeeProfile = (me, target) => {
  if (!isManagerProfileRole(target?.role)) return true;
  return canEditManagerProfiles(me);
};

/** Is this employee record the signed-in user's own? */
export const isSelf = (me, target) => {
  const mine = String(me?._id || me?.id || '');
  const theirs = String(target?._id || target || '');
  return !!mine && mine === theirs;
};

/**
 * May this account act on THIS employee as an administrator — edit them, confirm
 * their probation, set their salary?
 *
 * Two rules in one, because every admin surface needs both. Nobody administers
 * their own record (mirrors cannotManageProfile on the server: an HR set as
 * their own HR Partner could otherwise approve their own leave and raise their
 * own salary), and a Manager's record needs the manager-profile grant.
 * The Backend is exempt from the first rule, as it is server-side.
 * @param {object|null} me - the signed-in user
 * @param {object|null} target - the employee's linked account (needs `_id`, `role`)
 * @returns {boolean}
 */
export const canAdministerEmployee = (me, target) => {
  if (me?.role !== 'SuperAdmin' && isSelf(me, target)) return false;
  return canEditEmployeeProfile(me, target);
};

/**
 * Can this account open the /admin portal at all?
 *
 * Role alone isn't the answer for a Manager: the role exists for team duties
 * (approving your own team's leave) and most Managers hold no admin capability,
 * so the admin shell only opens for one who has actually been granted something.
 * Without this a granted Manager would pass every server check and still have
 * no page to reach them from.
 * @param {object|null} user
 * @returns {boolean}
 */
export function canUseAdminPortal(user) {
  if (!user) return false;
  if (['SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager', 'AccountsManager'].includes(user.role)) return true;
  if (user.role === 'Manager') return Array.isArray(user.permissions) && user.permissions.length > 0;
  return false;
}

export function hasAnyPermission(user, caps = []) {
  return caps.some((c) => hasPermission(user, c));
}

// CEO / MD. Read-only by default; a SuperAdmin can switch an individual account
// into edit mode (User.execEditAccess), after which it writes like an HR Manager
// holding every capability. Mirrors isExecViewer/isReadOnlyExec in the backend's
// authMiddleware — use isReadOnlyExec to decide whether to offer an action, so a
// button is never shown that the server will refuse.
export const isExecViewer = (user) => user?.role === 'CEO' || user?.role === 'MD';
export const isReadOnlyExec = (user) => isExecViewer(user) && user?.execEditAccess !== true;
export const isEditingExec = (user) => isExecViewer(user) && user?.execEditAccess === true;
