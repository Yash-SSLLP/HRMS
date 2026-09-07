// System roles + their human-friendly labels. Keep the keys in sync with
// backend/models/User.js ROLES. LDManager is displayed as "HR L&D" (a
// Learning & Development admin whose only admin power is the LMS/Courses module).
// God = the portal's permanently view-only audit login: it reads the admin
// portal for the companies a Super Admin assigns it and can change nothing.
export const ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager', 'God', 'Employee'];

export const ROLE_LABELS = {
  SuperAdmin: 'Super Admin',
  HRManager: 'HR Manager',
  CEO: 'CEO',
  MD: 'MD',
  Manager: 'Manager',
  LDManager: 'HR L&D',
  AccountsManager: 'Account Manager',
  God: 'God',
  Employee: 'Employee',
};

export const roleLabel = (r) => ROLE_LABELS[r] || r;
