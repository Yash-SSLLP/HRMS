// Catalog of granular admin capabilities a SuperAdmin can grant to an HR Manager.
// Each key gates one or more backend routes (via requirePermission) and, on the
// client, one or more nav items. Keep keys stable — they're stored on User docs.
//
// Semantics (see models/User.js + middleware/authMiddleware.js):
//   SuperAdmin            → implicitly has every capability
//   HRManager, undefined  → treated as ALL (existing HRs keep full access)
//   HRManager, [...]      → exactly the listed capabilities
//   LDManager             → only 'courses.manage'
//   other roles           → role-gated elsewhere, not via this catalog

const PERMISSIONS = [
  // People
  { key: 'users.manage', label: 'Create / manage users', group: 'People' },
  { key: 'employees.manage', label: 'Create / manage employees', group: 'People' },
  { key: 'org.manage', label: 'Org masters, departments, work locations', group: 'People' },
  { key: 'lifecycle.manage', label: 'Confirmations / probation', group: 'People' },
  { key: 'onboarding.manage', label: 'Onboarding tasks', group: 'People' },
  { key: 'exit.manage', label: 'Exits / offboarding', group: 'People' },

  // Recruitment (the sub-actions the business asked to control separately)
  { key: 'recruitment.jobs', label: 'Post / edit jobs', group: 'Recruitment' },
  { key: 'recruitment.candidates', label: 'Manage candidates, offers, appointment', group: 'Recruitment' },
  { key: 'recruitment.interviews', label: 'Schedule / assign interviews', group: 'Recruitment' },

  // Time & attendance
  { key: 'attendance.manage', label: 'Attendance, shifts, regularization', group: 'Time & Attendance' },
  { key: 'leave.manage', label: 'Leave (override), comp-off, holidays', group: 'Time & Attendance' },

  // Payroll & finance
  { key: 'payroll.manage', label: 'Payroll & salary structures', group: 'Payroll & Finance' },
  { key: 'declarations.manage', label: 'Tax declarations', group: 'Payroll & Finance' },
  { key: 'loans.manage', label: 'Loans & advances', group: 'Payroll & Finance' },
  { key: 'expenses.manage', label: 'Expenses', group: 'Payroll & Finance' },
  { key: 'travel.manage', label: 'Travel requests', group: 'Payroll & Finance' },
  { key: 'compliance.view', label: 'Compliance reports', group: 'Payroll & Finance' },

  // Performance & learning
  { key: 'performance.manage', label: 'Performance & appraisals', group: 'Performance & Learning' },
  { key: 'training.manage', label: 'Training', group: 'Performance & Learning' },
  { key: 'courses.manage', label: 'Courses / LMS', group: 'Performance & Learning' },

  // Work management
  { key: 'projects.manage', label: 'Projects', group: 'Work Management' },
  { key: 'tasks.manage', label: 'Tasks', group: 'Work Management' },
  { key: 'assets.manage', label: 'Assets', group: 'Work Management' },
  { key: 'documents.manage', label: 'Documents', group: 'Work Management' },

  // Engagement & communication
  { key: 'announcements.manage', label: 'Announcements', group: 'Engagement' },
  { key: 'surveys.manage', label: 'Surveys & polls', group: 'Engagement' },
  { key: 'events.manage', label: 'Events', group: 'Engagement' },
  { key: 'kb.manage', label: 'Knowledge base', group: 'Engagement' },

  // Reports & insights
  { key: 'analytics.view', label: 'HR analytics', group: 'Reports & Insights' },
  { key: 'audit.view', label: 'Audit log', group: 'Reports & Insights' },
];

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);
const isValidPermission = (key) => PERMISSION_KEY_SET.has(key);

module.exports = { PERMISSIONS, PERMISSION_KEYS, PERMISSION_KEY_SET, isValidPermission };
