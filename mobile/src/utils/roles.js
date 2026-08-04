// Role helpers mirroring the backend's authorization model.
//  SuperAdmin / HRManager → portal admins (full read + write)
//  CEO / MD               → read-only executives (view admin data, no writes),
//                           unless a SuperAdmin has switched that account into
//                           edit mode (User.execEditAccess)
//  Manager                → approves leave for / sees their direct reports
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

// Can view the admin portal data (admins + execs, in either mode).
export const canViewAdmin = (u) => isAdmin(u) || isExec(u);

// Can actually approve/reject/change (admins, plus an exec in edit mode; a
// view-only exec is read-only).
export const canApprove = (u) => isAdmin(u) || isEditingExec(u);

// Has a "My Team" view: managers, plus admins/execs who may also manage reports.
export const hasTeam = (u) => isManager(u) || canViewAdmin(u);

// Should the dashboard surface the admin/manager entry at all?
export const showsAdminEntry = (u) => canViewAdmin(u) || isManager(u);
