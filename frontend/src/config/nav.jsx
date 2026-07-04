// Sidebar navigation config for the admin and employee portals.
// Items use react-icons (SVG) — no emojis. Both navs are grouped into
// collapsible categories ({ group, items }).
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

// `perm` = capability required to see this item (HR Managers only — SuperAdmin,
// CEO/MD and, for courses, LDManager pass via hasPermission). `anyPerm` = show if
// the user holds ANY of the listed capabilities. Items with neither are visible
// to every admin-portal role.
export const adminNav = [
  { group: 'Overview, Reports & Admin Tools', items: [
    { to: '/admin/dashboard', label: 'Dashboard', icon: FiHome },
    { to: '/admin/analytics', label: 'Analytics', icon: FiBarChart2, perm: 'analytics.view' },
    { to: '/admin/audit-log', label: 'Audit Log', icon: FiFileText, perm: 'audit.view' },
    { to: '/admin/chat-export', label: 'Chat Export', icon: FiMessageSquare, roles: ['SuperAdmin'] },
  ] },
  { group: 'Organization Setup', items: [
    { to: '/admin/org-masters', label: 'Org Masters', icon: FiLayers, perm: 'org.manage' },
    { to: '/admin/departments', label: 'Departments', icon: FiGrid, perm: 'org.manage' },
    { to: '/admin/work-locations', label: 'Work Locations', icon: FiMap, perm: 'org.manage' },
    { to: '/admin/org-chart', label: 'Org Chart', icon: FiGitBranch },
    { to: '/admin/users', label: 'Users', icon: FiUsers, perm: 'users.manage' },
    { to: '/admin/employees', label: 'Employees', icon: FiBriefcase, perm: 'employees.manage' },
  ] },
  { group: 'Recruitment & Onboarding', items: [
    { to: '/admin/recruitment', label: 'Recruitment', icon: FiUserPlus, anyPerm: ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews'] },
    { to: '/admin/hiring-onboarding', label: 'Onboarding', icon: FiClipboard, perm: 'recruitment.candidates' },
    { to: '/admin/onboarding', label: 'Onboarding Tasks', icon: FiCheckSquare, perm: 'onboarding.manage' },
    { to: '/admin/new-joinees', label: 'New Joinees', icon: FiUserCheck, perm: 'recruitment.candidates' },
    { to: '/admin/confirmations', label: 'Confirmations', icon: FiShield, perm: 'lifecycle.manage' },
  ] },
  { group: 'Attendance & Time', items: [
    { to: '/admin/attendance', label: 'Attendance', icon: FiClock, perm: 'attendance.manage' },
    { to: '/admin/attendance-report', label: 'Attendance Report', icon: FiActivity, perm: 'attendance.manage' },
    { to: '/admin/attendance-month', label: 'Monthly View', icon: FiCalendar, perm: 'attendance.manage' },
    { to: '/admin/roster', label: 'Shifts & Roster', icon: FiCalendar, perm: 'attendance.manage' },
    { to: '/admin/regularizations', label: 'Regularization', icon: FiTool, perm: 'attendance.manage' },
  ] },
  { group: 'Leave & Holidays', items: [
    { to: '/admin/leave', label: 'Leave', icon: FiUmbrella, perm: 'leave.manage' },
    { to: '/admin/leave-approvals', label: 'Leave Approvals', icon: FiCheckSquare },
    { to: '/admin/compoff', label: 'Comp-off', icon: FiRepeat, perm: 'leave.manage' },
    { to: '/admin/holidays', label: 'Holidays', icon: FiSun, perm: 'leave.manage' },
  ] },
  { group: 'Payroll & Compensation', items: [
    { to: '/admin/payroll', label: 'Payroll', icon: FiDollarSign, perm: 'payroll.manage' },
    { to: '/admin/payroll-run', label: 'Monthly Payroll Run', icon: FiRepeat, perm: 'payroll.manage' },
    { to: '/admin/salary-structures', label: 'Salary Structures', icon: FiSliders, perm: 'payroll.manage' },
    { to: '/admin/loans', label: 'Loans & Advances', icon: FiCreditCard, perm: 'loans.manage' },
    { to: '/admin/declarations', label: 'Tax Declarations', icon: FiPercent, perm: 'declarations.manage' },
    { to: '/admin/compliance', label: 'Compliance', icon: FiCheckCircle, perm: 'compliance.view' },
  ] },
  { group: 'Expense & Travel', items: [
    { to: '/admin/expenses', label: 'Expenses', icon: FiShoppingBag, perm: 'expenses.manage' },
    { to: '/admin/travel', label: 'Travel', icon: FiMap, perm: 'travel.manage' },
  ] },
  { group: 'Performance & Learning', items: [
    { to: '/admin/performance', label: 'Performance', icon: FiTrendingUp, perm: 'performance.manage' },
    { to: '/admin/review-cycles', label: 'Appraisals', icon: FiEdit, perm: 'performance.manage' },
    { to: '/admin/training', label: 'Training', icon: FiBookOpen, perm: 'training.manage' },
    { to: '/admin/courses', label: 'Courses (LMS)', icon: FiBook, perm: 'courses.manage', ld: true },
  ] },
  { group: 'Work Management', items: [
    { to: '/admin/projects', label: 'Projects', icon: FiFolder, perm: 'projects.manage' },
    { to: '/admin/tasks', label: 'Tasks', icon: FiList, perm: 'tasks.manage' },
    { to: '/admin/assets', label: 'Assets', icon: FiPackage, perm: 'assets.manage' },
    { to: '/admin/documents', label: 'Documents', icon: FiFile, perm: 'documents.manage' },
  ] },
  { group: 'Engagement & Communication', items: [
    { to: '/admin/announcements', label: 'Announcements', icon: FiVolume2, perm: 'announcements.manage' },
    { to: '/admin/surveys', label: 'Surveys', icon: FiPieChart, perm: 'surveys.manage' },
    { to: '/admin/events', label: 'Events', icon: FiFlag, perm: 'events.manage' },
    { to: '/admin/calendar', label: 'Calendar', icon: FiCalendar },
    { to: '/admin/recognition', label: 'Recognition', icon: FiAward },
    { to: '/admin/knowledge-base', label: 'Knowledge Base', icon: FiHelpCircle, perm: 'kb.manage' },
  ] },
  { group: 'Employee Self-Service / Requests', items: [
    { to: '/admin/account', label: 'My Account', icon: FiKey },
    { to: '/admin/complaints', label: 'Complaints', icon: FiAlertTriangle },
    { to: '/admin/change-requests', label: 'Change Requests', icon: FiEdit3 },
    { to: '/admin/password-resets', label: 'Password Resets', icon: FiKey, perm: 'users.manage' },
  ] },
  { group: 'Exit', items: [
    { to: '/admin/exits', label: 'Exits', icon: FiLogOut, perm: 'exit.manage' },
  ] },
];

// HR L&D (LDManager) is an LMS-only admin: they enter the admin portal but see
// only the Courses page. A flat, single-item nav keeps the sidebar unambiguous.
export const ldNav = [
  { to: '/admin/courses', label: 'Courses (LMS)', end: true, icon: FiBook },
];

export const employeeNav = [
  { group: 'Overview', items: [
    { to: '/employee', label: 'Overview', end: true, icon: FiHome },
    { to: '/employee/team', label: 'My Team', icon: FiUsers, roles: ['Manager'] },
    { to: '/employee/interviews', label: 'My Interviews', icon: FiUserCheck },
    { to: '/employee/org-chart', label: 'Org Chart', icon: FiGitBranch },
    { to: '/employee/onboarding', label: 'Onboarding', icon: FiClipboard },
  ] },
  { group: 'Attendance & Time', items: [
    { to: '/employee/attendance', label: 'Attendance', icon: FiClock, highlight: true },
    { to: '/employee/shifts', label: 'My Shifts', icon: FiCalendar },
    { to: '/employee/regularizations', label: 'Regularization', icon: FiTool },
  ] },
  { group: 'Leave & Holidays', items: [
    { to: '/employee/leave', label: 'Leave', icon: FiUmbrella },
    { to: '/employee/compoff', label: 'Comp-off', icon: FiRepeat },
  ] },
  { group: 'Payroll & Expenses', items: [
    { to: '/employee/payslips', label: 'Payslips', icon: FiDollarSign },
    { to: '/employee/loans', label: 'Loans & Advances', icon: FiCreditCard },
    { to: '/employee/declaration', label: 'Tax Declaration', icon: FiPercent },
    { to: '/employee/expenses', label: 'Expenses', icon: FiShoppingBag },
    { to: '/employee/travel', label: 'Travel', icon: FiMap },
  ] },
  { group: 'Performance & Learning', items: [
    { to: '/employee/goals', label: 'Goals', icon: FiTarget },
    { to: '/employee/reviews', label: 'My Reviews', icon: FiEdit },
    { to: '/employee/learning', label: 'Learning', icon: FiBookOpen },
  ] },
  { group: 'Work Management', items: [
    { to: '/employee/tasks', label: 'Tasks', icon: FiList },
    { to: '/employee/assets', label: 'Assets', icon: FiPackage },
    { to: '/employee/documents', label: 'Documents', icon: FiFile },
  ] },
  { group: 'Engagement & Communication', items: [
    { to: '/employee/recognition', label: 'Recognition', icon: FiAward },
    { to: '/employee/announcements', label: 'Announcements', icon: FiVolume2 },
    { to: '/employee/surveys', label: 'Surveys', icon: FiPieChart },
    { to: '/employee/calendar', label: 'Calendar', icon: FiCalendar },
    { to: '/employee/knowledge-base', label: 'Help / KB', icon: FiHelpCircle },
  ] },
  { group: 'Employee Self-Service / Requests', items: [
    { to: '/employee/profile', label: 'Profile', icon: FiUser },
    { to: '/employee/account', label: 'Account & Requests', icon: FiKey },
    { to: '/employee/complaints', label: 'Complaints', icon: FiAlertTriangle },
  ] },
  { group: 'Exit', items: [
    { to: '/employee/exit', label: 'Resignation', icon: FiLogOut, danger: true },
  ] },
];
