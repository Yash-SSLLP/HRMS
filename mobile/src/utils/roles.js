// Role helpers mirroring the backend's authorization model.
//  SuperAdmin / HRManager → portal admins (full read + write)
//  CEO / MD               → read-only executives (view admin data, no writes),
//                           unless a SuperAdmin has switched that account into
//                           edit mode (User.execEditAccess)
//  Manager                → approves leave for / sees their direct reports, plus
//                           whatever granular capabilities a SuperAdmin granted
//  Employee               → self-service only
//
// Every helper takes EITHER a role string or the whole user object. Prefer
// passing the user: `execEditAccess` lives on the account, not the role, so
// canApprove() can only see an exec's edit mode when given the object. A bare
// role string still works and falls back to the read-only (safer) answer.

const roleOf = (u) => (u && typeof u === 'object' ? u.role : u);

export const isAdmin = (u) => roleOf(u) === 'SuperAdmin' || roleOf(u) === 'HRManager';
export const isExec = (u) => roleOf(u) === 'CEO' || roleOf(u) === 'MD';
export const isManager = (u) => roleOf(u) === 'Manager';
export const isSuperAdmin = (u) => roleOf(u) === 'SuperAdmin';

// A CEO/MD a SuperAdmin has put in edit mode — writes like an HR Manager holding
// every capability. Needs the user object; a role string alone can't say.
export const isEditingExec = (u) => isExec(u) && u?.execEditAccess === true;

// SuperAdmin, and now CEO/MD, are NOT employees (no employee profile) — so they
// get NO employee self-service (no attendance punch, leave, payslips, etc.),
// only the admin/exec surface. CEO/MD still approve leave (as reporting-chain
// approvers) and can be interviewers. HRManager IS still an employee.
export const canEmployeeSelf = (u) => {
  const role = roleOf(u);
  return role !== 'SuperAdmin' && role !== 'CEO' && role !== 'MD';
};

/**
 * Does this account hold a granular capability? Mirrors `hasPermission` in
 * backend/middleware/authMiddleware.js — the server is still the real gate;
 * this only decides what to put on screen.
 *
 * Note the deliberate asymmetry between the two grantable roles: an HR Manager
 * with NO permissions array holds everything (a migration default from before
 * the catalogue existed), while a Manager with no array holds nothing. Copying
 * the HR default onto Manager would show every line manager the full console.
 *
 * @param {object|null} u - the user object (a bare role string can't answer this)
 * @param {string} cap - capability key, e.g. 'payroll.manage'
 * @returns {boolean}
 */
export function hasPermission(u, cap) {
  if (!u || typeof u !== 'object') return false;
  if (u.role === 'SuperAdmin') return true;
  if (isEditingExec(u)) return true;
  // Standalone grants that ride on a flag rather than the role.
  if (cap === 'cashbook.manage' && u.cashbookAccess === true) return true;
  if (cap === 'expenses.manage' && u.expensesAccess === true) return true;
  if (cap === 'assets.manage' && u.assetsAccess === true) return true;
  // Khata access is the same kind of standalone grant. It opens the module;
  // WHICH cash account they may pay from is decided per account on the server.
  if (cap === 'khata.manage' && u.khataAccess === true) return true;
  if (u.role === 'LDManager') return cap === 'courses.manage';
  if (u.role === 'AccountsManager') {
    return cap === 'cashbook.manage' || cap === 'expenses.manage' || cap === 'khata.manage';
  }
  if (u.role === 'HRManager') {
    const p = u.permissions;
    if (p === undefined || p === null) return true; // not configured → all
    return Array.isArray(p) && p.includes(cap);
  }
  if (u.role === 'Manager') return Array.isArray(u.permissions) && u.permissions.includes(cap);
  return false;
}

/** True when the account holds ANY of the given capabilities. */
export const hasAnyPermission = (u, caps = []) => caps.some((c) => hasPermission(u, c));

/** A Manager who has actually been granted something. */
export const isGrantedManager = (u) =>
  isManager(u) && Array.isArray(u?.permissions) && u.permissions.length > 0;

// Can view the admin portal data. Admins and execs always; a Manager only once
// a SuperAdmin has granted them at least one capability — the role on its own
// is a team duty (approving your own reports' leave), not admin access.
export const canViewAdmin = (u) => isAdmin(u) || isExec(u) || isGrantedManager(u);

// Can actually approve/reject/change (admins, plus an exec in edit mode; a
// view-only exec is read-only). A granted Manager's write access is decided
// per capability by hasPermission, NOT here — this stays the blanket
// admin-everywhere answer, so it must not open up for them.
export const canApprove = (u) => isAdmin(u) || isEditingExec(u);

/**
 * May this account make CHANGES in the module gated by `cap`?
 *
 * This is what an admin screen should use for its `writable` flag, rather than
 * canApprove() alone:
 *   - a granted Manager can write in the modules they hold, and only those;
 *   - an HR Manager whose capability list was trimmed no longer gets write
 *     buttons for modules they don't hold (the server already refused those,
 *     so the buttons only ever produced an error);
 *   - a read-only exec still writes nothing, an exec in edit mode still writes.
 * @param {object|null} u
 * @param {string} cap
 * @returns {boolean}
 */
export const canManage = (u, cap) => (canApprove(u) || isGrantedManager(u)) && hasPermission(u, cap);

// Has a "My Team" view: managers, plus admins/execs who may also manage reports.
export const hasTeam = (u) => isManager(u) || canViewAdmin(u);

// Should the dashboard surface the admin/manager entry at all?
export const showsAdminEntry = (u) => canViewAdmin(u) || isManager(u);
