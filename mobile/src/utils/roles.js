// Role helpers mirroring the backend's authorization model.
//  SuperAdmin / HRManager → portal admins (full read + write)
//  CEO / MD               → read-only executives (view admin data, no writes)
//  Manager                → approves leave for / sees their direct reports
//  Employee               → self-service only

export const isAdmin = (role) => role === 'SuperAdmin' || role === 'HRManager';
export const isExec = (role) => role === 'CEO' || role === 'MD';
export const isManager = (role) => role === 'Manager';
export const isSuperAdmin = (role) => role === 'SuperAdmin';

// SuperAdmin is a pure portal admin with no employee profile — so they get NO
// employee self-service (no attendance punch, leave, payslips, etc.), only the
// admin surface. Everyone else (incl. HRManager, CEO/MD) is also an employee.
export const canEmployeeSelf = (role) => role !== 'SuperAdmin';

// Can view the admin portal data (admins + read-only execs).
export const canViewAdmin = (role) => isAdmin(role) || isExec(role);

// Can actually approve/reject/change (admins only; execs are read-only).
export const canApprove = (role) => isAdmin(role);

// Has a "My Team" view: managers, plus admins/execs who may also manage reports.
export const hasTeam = (role) => isManager(role) || canViewAdmin(role);

// Should the dashboard surface the admin/manager entry at all?
export const showsAdminEntry = (role) => canViewAdmin(role) || isManager(role);
