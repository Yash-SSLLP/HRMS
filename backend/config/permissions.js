// Catalog of granular admin capabilities a SuperAdmin can grant to an HR Manager.
// Each key gates one or more backend routes (via requirePermission) and, on the
// client, one or more nav items. Keep keys stable — they're stored on User docs.
//
// Semantics (see models/User.js + middleware/authMiddleware.js):
//   SuperAdmin            → implicitly has every capability
//   HRManager, undefined  → treated as ALL (existing HRs keep full access)
//   HRManager, [...]      → exactly the listed capabilities
//   Manager,   undefined  → NONE. Note this is the opposite of the HRManager
//                           default above: that one is a migration convenience
//                           from before the catalogue existed, and reusing it
//                           for Manager would promote every line manager to
//                           full admin the moment the role became grantable.
//   Manager,   [...]      → exactly the listed capabilities
//   LDManager             → only 'courses.manage'
//   other roles           → role-gated elsewhere, not via this catalog
//
// A Manager's team duties (their own team's leave approvals, team attendance)
// are gated by role in the routes, NOT by this catalogue — granting or clearing
// capabilities here never takes those away.

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
  { key: 'cashbook.manage', label: 'Cashbook', group: 'Payroll & Finance' },
  // Opens the employee-khata module (per-employee cash ledgers). Deliberately
  // separate from cashbook.manage: this is about handing money to PEOPLE, which
  // is a different trust decision from editing the company's own books. Note
  // that holding it is necessary but not sufficient to pay anyone — the operator
  // must also be listed on the specific CashAccount (CashAccount.operators).
  { key: 'khata.manage', label: 'Employee khata (cash advances & settlements)', group: 'Payroll & Finance' },
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
  // Editing what every outgoing email and letter SAYS is a company-voice
  // decision, so it is its own capability rather than riding on the module that
  // happens to send the mail.
  { key: 'templates.manage', label: 'Email & letter templates', group: 'Engagement' },

  // Reports & insights
  { key: 'analytics.view', label: 'HR analytics', group: 'Reports & Insights' },
  // NOTE: 'audit.view' was retired — the audit log is SuperAdmin-only and is no
  // longer a grantable capability (see routes/auditRoutes.js). The key may still
  // sit in old User.permissions arrays; it is inert, since hasPermission only
  // answers to catalogued keys.
];

/**
 * Roles whose `permissions` array is meaningful — i.e. the accounts a SuperAdmin
 * can hand individual capabilities to from the Permissions page. Every other
 * role is gated by role alone. Keep the client mirror in
 * frontend/src/config/permissions.js in step.
 */
const GRANTABLE_ROLES = ['HRManager', 'Manager'];

const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
const PERMISSION_KEY_SET = new Set(PERMISSION_KEYS);
/**
 * @param {string} key - A capability key to validate.
 * @returns {boolean} True if `key` is one of the catalogued permission keys.
 */
const isValidPermission = (key) => PERMISSION_KEY_SET.has(key);

module.exports = { PERMISSIONS, PERMISSION_KEYS, PERMISSION_KEY_SET, GRANTABLE_ROLES, isValidPermission };
