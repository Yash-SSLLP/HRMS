// Sidebar navigation config for the admin and employee portals.
// Items use react-icons (SVG) — no emojis. Both navs are grouped into
// collapsible categories ({ group, items }).
//
// Ordering rule (both portals): categories run most-used first — the daily
// work (attendance, leave, people, payroll) sits above the fold, and the
// occasional stuff (reports, account, exits, help) sinks to the bottom.
// Items inside a category follow the same rule.
import {
  FiHome, FiBarChart2, FiFileText, FiMessageSquare,
  FiLayers, FiGrid, FiGitBranch, FiUsers, FiBriefcase,
  FiUserPlus, FiCheckSquare, FiUserCheck, FiShield,
  FiClock, FiActivity, FiCalendar, FiTool,
  FiUmbrella, FiRepeat, FiSun,
  FiDollarSign, FiSliders, FiCreditCard, FiClipboard, FiCheckCircle,
  FiShoppingBag, FiMap, FiPercent, FiTrendingUp, FiEdit, FiBookOpen, FiBook,
  FiFolder, FiList, FiPackage, FiFile,
  FiVolume2, FiPieChart, FiFlag, FiAward, FiHelpCircle,
  FiKey, FiAlertTriangle, FiEdit3, FiLogOut, FiUser, FiTarget,
} from 'react-icons/fi';
// Feather has no money-ledger glyph; Tabler's outline set matches it visually
// (same stroke weight) and is already used elsewhere (AdminOverview).
import { TbCashBanknote, TbReceipt } from 'react-icons/tb';

// A group's `icon` is used when permissions leave it with a single visible item:
// NavList then renders it as one plain section link, and without an icon that
// row reads as an inert heading rather than a link (see NavList in Layout.jsx).
//
// `perm` = capability required to see this item (HR Managers only — SuperAdmin,
// CEO/MD and, for courses, LDManager pass via hasPermission). `anyPerm` = show if
// the user holds ANY of the listed capabilities. Items with neither are visible
// to every admin-portal role.
// `feature: 'chat'` = hide unless the org-wide chat switch is on, so the whole
// module disappears together (top-bar launcher, dock and this) rather than
// leaving a stray chat page behind.
export const adminNav = [
  // Pinned above every category: the landing page is reached constantly and
  // shouldn't need a dropdown opened first. An entry with no `group` renders as
  // a plain top-level link (see NavList in components/Layout.jsx).
  { to: '/admin/dashboard', label: 'Dashboard', icon: FiHome },
  { group: 'Attendance & Shifts', icon: FiClock, items: [
    { to: '/admin/presence', label: "Who's In / On Leave", icon: FiUserCheck, perm: 'attendance.manage' },
    { to: '/admin/attendance', label: 'Attendance', icon: FiClock, perm: 'attendance.manage' },
    { to: '/admin/attendance-month', label: 'Monthly View', icon: FiCalendar, perm: 'attendance.manage' },
    { to: '/admin/attendance-report', label: 'Attendance Report', icon: FiActivity, perm: 'attendance.manage' },
    { to: '/admin/regularizations', label: 'Regularization', icon: FiTool, perm: 'attendance.manage' },
    { to: '/admin/roster', label: 'Shifts & Roster', icon: FiCalendar, perm: 'attendance.manage' },
    { to: '/admin/punch-map', label: 'Punch Map', icon: FiMap, perm: 'attendance.manage' },
  ] },
  { group: 'Leave & Holidays', icon: FiUmbrella, items: [
    { to: '/admin/leave', label: 'Leave', icon: FiUmbrella, perm: 'leave.manage' },
    { to: '/admin/approvals', label: 'Approvals', icon: FiCheckSquare },
    { to: '/admin/holidays', label: 'Holidays', icon: FiSun, perm: 'leave.manage' },
  ] },
  { group: 'People & Organization', icon: FiUsers, items: [
    { to: '/admin/employees', label: 'Employees', icon: FiBriefcase, perm: 'employees.manage' },
    { to: '/admin/users', label: 'Users', icon: FiUsers, perm: 'users.manage' },
    { to: '/admin/org-chart', label: 'Org Chart', icon: FiGitBranch },
    { to: '/admin/departments', label: 'Departments', icon: FiGrid, perm: 'org.manage' },
    { to: '/admin/work-locations', label: 'Work Locations', icon: FiMap, perm: 'org.manage' },
    { to: '/admin/org-masters', label: 'Org Masters', icon: FiLayers, perm: 'org.manage' },
    { to: '/admin/permissions', label: 'Permissions', icon: FiShield, roles: ['SuperAdmin'] },
  ] },
  { group: 'Payroll & Salary', icon: FiDollarSign, items: [
    { to: '/admin/payroll', label: 'Payroll', icon: FiDollarSign, perm: 'payroll.manage' },
    { to: '/admin/salary-structures', label: 'Salary Structures', icon: FiSliders, perm: 'payroll.manage' },
    { to: '/admin/payroll-run', label: 'Hikes', icon: FiRepeat, perm: 'payroll.manage' },
    { to: '/admin/loans', label: 'Loans & Advances', icon: FiCreditCard, perm: 'loans.manage' },
    { to: '/admin/declarations', label: 'Tax Declarations', icon: FiPercent, perm: 'declarations.manage' },
    { to: '/admin/compliance', label: 'Compliance', icon: FiCheckCircle, perm: 'compliance.view' },
  ] },
  // Cashbook used to be a category of its own, which meant it rendered as a
  // bare section link with no icon (see the single-item branch in NavList).
  // Folded in with the other money-out modules so it gets a real nav row.
  { group: 'Expenses & Cashbook', icon: FiShoppingBag, items: [
    { to: '/admin/expenses', label: 'Expenses', icon: FiShoppingBag, perm: 'expenses.manage' },
    { to: '/admin/cashbook', label: 'Cashbook', icon: TbCashBanknote, perm: 'cashbook.manage' },
    { to: '/admin/travel', label: 'Travel', icon: FiMap, perm: 'travel.manage' },
  ] },
  { group: 'Hiring & Onboarding', icon: FiUserPlus, items: [
    { to: '/admin/recruitment', label: 'Recruitment', icon: FiUserPlus, anyPerm: ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews'] },
    { to: '/admin/hiring-onboarding', label: 'Onboarding', icon: FiClipboard, perm: 'recruitment.candidates' },
    { to: '/admin/new-joinees', label: 'New Joinees', icon: FiUserCheck, perm: 'recruitment.candidates' },
    { to: '/admin/onboarding', label: 'Onboarding Tasks', icon: FiCheckSquare, perm: 'onboarding.manage' },
    { to: '/admin/confirmations', label: 'Confirmations', icon: FiShield, perm: 'lifecycle.manage' },
  ] },
  { group: 'Performance & Learning', icon: FiTrendingUp, items: [
    { to: '/admin/performance', label: 'Performance', icon: FiTrendingUp, perm: 'performance.manage' },
    { to: '/admin/review-cycles', label: 'Appraisals', icon: FiEdit, perm: 'performance.manage' },
    { to: '/admin/courses', label: 'Courses (LMS)', icon: FiBook, perm: 'courses.manage', ld: true },
    { to: '/admin/training', label: 'Training', icon: FiBookOpen, perm: 'training.manage' },
  ] },
  { group: 'Projects & Resources', icon: FiFolder, items: [
    { to: '/admin/projects', label: 'Projects', icon: FiFolder, perm: 'projects.manage' },
    { to: '/admin/tasks', label: 'Tasks', icon: FiList, perm: 'tasks.manage' },
    { to: '/admin/documents', label: 'Documents', icon: FiFile, perm: 'documents.manage' },
    { to: '/admin/assets', label: 'Assets', icon: FiPackage, perm: 'assets.manage' },
  ] },
  { group: 'Communication & Culture', icon: FiVolume2, items: [
    { to: '/admin/calendar', label: 'Calendar', icon: FiCalendar, highlight: true },
    { to: '/admin/announcements', label: 'Announcements', icon: FiVolume2, perm: 'announcements.manage' },
    { to: '/admin/events', label: 'Events', icon: FiFlag, perm: 'events.manage' },
    { to: '/admin/rnr', label: 'Rewards & Recognition', icon: FiAward, perm: 'announcements.manage' },
    { to: '/admin/surveys', label: 'Surveys', icon: FiPieChart, perm: 'surveys.manage' },
  ] },
  { group: 'Reports & Audit', icon: FiBarChart2, items: [
    { to: '/admin/analytics', label: 'Analytics', icon: FiBarChart2, perm: 'analytics.view' },
    { to: '/admin/audit-log', label: 'Audit Log', icon: FiFileText, roles: ['SuperAdmin'] },
    { to: '/admin/chat-export', label: 'Chat Export', icon: FiMessageSquare, roles: ['SuperAdmin'], feature: 'chat' },
  ] },
  { group: 'My Account & Requests', icon: FiKey, items: [
    { to: '/admin/account', label: 'My Account', icon: FiKey },
    { to: '/admin/change-requests', label: 'Change Requests', icon: FiEdit3 },
    { to: '/admin/complaints', label: 'Complaints', icon: FiAlertTriangle },
    { to: '/admin/password-resets', label: 'Password Resets', icon: FiKey, perm: 'users.manage' },
  ] },
  { group: 'Exits', icon: FiLogOut, items: [
    { to: '/admin/exits', label: 'Exits', icon: FiLogOut, perm: 'exit.manage' },
  ] },
  // Last entry in the sidebar. A single-item group renders as a plain top-level
  // link labelled with the group name (see NavList in Layout.jsx), so this shows
  // as one "Help" link rather than a dropdown.
  { group: 'Help', icon: FiHelpCircle, items: [
    { to: '/admin/how-to-use', label: 'Help', icon: FiHelpCircle },
  ] },
];

// HR L&D (LDManager) is an LMS-only admin: they enter the admin portal but see
// only the Courses page. A flat, single-item nav keeps the sidebar unambiguous.
export const ldNav = [
  { to: '/admin/courses', label: 'Courses (LMS)', end: true, icon: FiBook },
];

// Account Manager (AccountsManager) is a cashbook-only admin: they enter the
// admin portal but see only the Cashbook page. Same flat-nav pattern as ldNav.
export const accountsNav = [
  { to: '/admin/cashbook', label: 'Cashbook', end: true, icon: TbCashBanknote },
];

export const employeeNav = [
  // Pinned above every category, as on the admin side: the landing page is
  // reached constantly and shouldn't need a dropdown opened first.
  { to: '/employee', label: 'Dashboard', end: true, icon: FiHome },
  { group: 'Attendance & Shifts', icon: FiClock, items: [
    { to: '/employee/attendance', label: 'Attendance', icon: FiClock, highlight: true },
    { to: '/employee/regularizations', label: 'Regularization', icon: FiTool },
    { to: '/employee/shifts', label: 'My Shifts', icon: FiCalendar },
  ] },
  // Single item — renders as a plain section link, so the group name is the
  // label the user actually sees. Keep it short.
  { group: 'Leave', icon: FiUmbrella, items: [
    { to: '/employee/leave', label: 'Leave', icon: FiUmbrella },
  ] },
  { group: 'My Work', icon: FiCheckSquare, items: [
    { to: '/employee/approvals', label: 'Approvals', icon: FiCheckSquare },
    { to: '/employee/team', label: 'My Team', icon: FiUsers, roles: ['Manager'] },
    { to: '/employee/interviews', label: 'My Interviews', icon: FiUserCheck },
    { to: '/employee/onboarding', label: 'Onboarding', icon: FiClipboard },
    { to: '/employee/org-chart', label: 'Org Chart', icon: FiGitBranch },
  ] },
  { group: 'Payroll & Expenses', icon: FiDollarSign, items: [
    { to: '/employee/payslips', label: 'Payslips', icon: FiDollarSign },
    { to: '/employee/expenses', label: 'Expenses', icon: FiShoppingBag },
    { to: '/employee/cashbook', label: 'Cash Vouchers', icon: TbReceipt },
    { to: '/employee/loans', label: 'Loans & Advances', icon: FiCreditCard },
    { to: '/employee/declaration', label: 'Tax Declaration', icon: FiPercent },
    { to: '/employee/travel', label: 'Travel', icon: FiMap },
    { to: '/employee/cashbook-manage', label: 'Cashbook', icon: TbCashBanknote, perm: 'cashbook.manage' },
  ] },
  { group: 'Performance & Learning', icon: FiTrendingUp, items: [
    { to: '/employee/goals', label: 'Goals', icon: FiTarget },
    { to: '/employee/reviews', label: 'My Reviews', icon: FiEdit },
    { to: '/employee/learning', label: 'Learning', icon: FiBookOpen },
  ] },
  { group: 'Projects & Resources', icon: FiFolder, items: [
    { to: '/employee/tasks', label: 'Tasks', icon: FiList },
    { to: '/employee/documents', label: 'Documents', icon: FiFile },
    { to: '/employee/assets', label: 'Assets', icon: FiPackage },
  ] },
  { group: 'Communication & Culture', icon: FiVolume2, items: [
    { to: '/employee/calendar', label: 'Calendar', icon: FiCalendar, highlight: true },
    { to: '/employee/announcements', label: 'Announcements', icon: FiVolume2 },
    { to: '/employee/surveys', label: 'Surveys', icon: FiPieChart },
  ] },
  { group: 'My Account', icon: FiUser, items: [
    { to: '/employee/profile', label: 'Profile', icon: FiUser },
    { to: '/employee/account', label: 'Account & Requests', icon: FiKey },
    { to: '/employee/complaints', label: 'Complaints', icon: FiAlertTriangle },
  ] },
  { group: 'Exits', icon: FiLogOut, items: [
    { to: '/employee/exit', label: 'Resignation', icon: FiLogOut, danger: true },
  ] },
  // Last entry in the sidebar — see the note on the admin Help group above.
  { group: 'Help', icon: FiHelpCircle, items: [
    { to: '/employee/how-to-use', label: 'Help', icon: FiHelpCircle },
  ] },
];
