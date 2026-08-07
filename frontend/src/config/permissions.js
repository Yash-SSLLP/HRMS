// Client mirror of backend middleware `hasPermission` — used only to show/hide
// nav items and action buttons. The server is the real enforcement boundary.
//
// SuperAdmin → all. CEO/MD → all (read-only viewers still see every page).
// LDManager → only courses. HRManager → their `permissions` array, where a
// missing/undefined array means ALL (existing HRs keep full access).
export function hasPermission(user, cap) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  if (user.role === 'CEO' || user.role === 'MD') return true;
  // Cashbook and expense access are standalone grants an admin can give to any
  // user/employee, whatever their role.
  if (cap === 'cashbook.manage' && user.cashbookAccess === true) return true;
  if (cap === 'expenses.manage' && user.expensesAccess === true) return true;
  if (user.role === 'LDManager') return cap === 'courses.manage';
  // Account Managers settle reimbursements out of the cashbook, so they hold the
  // expense capability alongside it.
  if (user.role === 'AccountsManager') return cap === 'cashbook.manage' || cap === 'expenses.manage';
  if (user.role === 'HRManager') {
    const p = user.permissions;
    if (p == null) return true; // undefined/null → all
    return Array.isArray(p) && p.includes(cap);
  }
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
