// System roles + their human-friendly labels. Keep the keys in sync with
// backend/models/User.js ROLES. LDManager is displayed as "HR L&D" (a
// Learning & Development admin whose only admin power is the LMS/Courses module).
export const ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager', 'Employee'];

export const ROLE_LABELS = {
  SuperAdmin: 'Super Admin',
  HRManager: 'HR Manager',
  CEO: 'CEO',
  MD: 'MD',
  Manager: 'Manager',
  LDManager: 'HR L&D',
  AccountsManager: 'Account Manager',
  Employee: 'Employee',
};

export const roleLabel = (r) => ROLE_LABELS[r] || r;
