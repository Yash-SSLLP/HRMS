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
  // Cashbook access is a standalone grant an admin can give to any user/employee.
  if (cap === 'cashbook.manage' && user.cashbookAccess === true) return true;
  if (user.role === 'LDManager') return cap === 'courses.manage';
  if (user.role === 'AccountsManager') return cap === 'cashbook.manage';
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
