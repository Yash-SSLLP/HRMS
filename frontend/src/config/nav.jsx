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
  FiSliders, FiCreditCard, FiClipboard, FiCheckCircle,
  FiShoppingBag, FiMap, FiPercent, FiTrendingUp, FiEdit, FiBookOpen, FiBook,
  FiFolder, FiList, FiPackage, FiFile,
  FiVolume2, FiPieChart, FiFlag, FiAward, FiHelpCircle,
  FiKey, FiLock, FiAlertTriangle, FiEdit3, FiLogOut, FiUser, FiTarget, FiBell, FiSmartphone,
  FiRotateCw, FiVideo, FiFilter, FiInbox,
} from 'react-icons/fi';
// Feather has no money-ledger glyph, and its only currency mark is a dollar sign
// — wrong for a company paid in rupees. Tabler's outline set matches Feather
// visually (same stroke weight) and is already used elsewhere (AdminOverview).
import { TbCashBanknote, TbReceipt, TbCurrencyRupee } from 'react-icons/tb';

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
// `anyExplicitPerm` = show if the user was EXPLICITLY granted any of these keys.
// Unlike `anyPerm` it does not pass an HR Manager who simply has no permissions
// array (which `hasPermission` reads as "everything") — the right question for a
// grant somebody had to be given one account at a time, and the same one the
// page behind it asks (see hasExplicitPermission).
// `badge` = which live pending count this row wears as a red number. The value
// is a key of the counts in store/navCountsStore.js — or a LIST of keys, summed,
// for a page holding more than one queue (Employee Cashbook has two, behind two
// different gates). NavList (components/Layout.jsx) reads it. A COLLAPSED group
// header shows the sum of its visible children's, so a shut category still says
// how much is waiting inside it.
// `keywords` = extra lower-case terms the global search should match that do not
// appear in the label — the other names people actually type ("khatabook" for
// Employee Cashbook). They never render; GlobalSearch is the only consumer.
export const adminNav = [
  // Pinned above every category: the landing page is reached constantly and
  // shouldn't need a dropdown opened first. An entry with no `group` renders as
  // a plain top-level link (see NavList in components/Layout.jsx).
  // Not offered to a Manager: the dashboard endpoints are gated above them, so
  // the row would advertise a page that answers 403 (see AdminHome in App.jsx).
  { to: '/admin/dashboard', label: 'Dashboard', icon: FiHome, roles: ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'God'] },
  // Approvals spans leave, resignations, no-dues clearance AND attendance
  // regularizations, so it outgrew the Leave category it used to sit in.
  // Pinned like Dashboard: it is a daily inbox, not an occasional lookup.
  { to: '/admin/approvals', label: 'Approvals', icon: FiCheckSquare, badge: 'mine' },
  { group: 'Attendance & Shifts', icon: FiClock, items: [
    { to: '/admin/presence', label: "Who's In / On Leave", icon: FiUserCheck, perm: 'attendance.manage' },
    { to: '/admin/attendance', label: 'Attendance', icon: FiClock, perm: 'attendance.manage' },
    { to: '/admin/attendance-month', label: 'Monthly View', icon: FiCalendar, perm: 'attendance.manage' },
    { to: '/admin/attendance-report', label: 'Attendance Report', icon: FiActivity, perm: 'attendance.manage' },
    // One screen now: who APPROVES a correction is configured on Permissions.
    { to: '/admin/regularizations', label: 'Regularization', icon: FiTool, perm: 'attendance.manage',
      badge: 'regularization',
      keywords: ['correction', 'punch correction', 'missed punch', 'regularise', 'regularize'] },
    { to: '/admin/roster', label: 'Shifts & Roster', icon: FiCalendar, perm: 'attendance.manage' },
    { to: '/admin/punch-map', label: 'Punch Map', icon: FiMap, perm: 'attendance.manage' },
  ] },
  { group: 'Leave & Holidays', icon: FiUmbrella, items: [
    // Two tabs now: who APPROVES leave is configured on Permissions.
    { to: '/admin/leave', label: 'Leave', icon: FiUmbrella, perm: 'leave.manage',
      badge: 'leave',
      tabs: [{ id: 'requests', label: 'Requests' }, { id: 'balances', label: 'Balances' }] },
    { to: '/admin/holidays', label: 'Holidays & Festivals', icon: FiSun, perm: 'leave.manage' },
  ] },
  { group: 'People & Organization', icon: FiUsers, items: [
    { to: '/admin/users', label: 'Users', icon: FiUsers, perm: 'users.manage' },
    { to: '/admin/employees', label: 'Employees', icon: FiBriefcase, perm: 'employees.manage' },
    { to: '/admin/org-chart', label: 'Org Chart', icon: FiGitBranch },
    // Backend only — the Companies tab was deliberately pulled from HR and the
    // executives (user decision 2026-08-26); the routes enforce the same.
    { to: '/admin/companies', label: 'Companies', icon: FiHome, roles: ['SuperAdmin'] },
    { to: '/admin/departments', label: 'Departments', icon: FiGrid, perm: 'org.manage' },
    { to: '/admin/work-locations', label: 'Work Locations', icon: FiMap, perm: 'org.manage' },
    { to: '/admin/org-masters', label: 'Org Masters', icon: FiLayers, perm: 'org.manage' },
    // EVERY ACCESS DECISION IN ONE PLACE. The module-access matrix (Super Admins
    // only), plus the two approval ladders that used to hide as setup tabs on
    // Leave and Regularization. Reachable by a Super Admin OR by whoever was
    // granted one of the ladders — each tab keeps its own grant, and the page
    // shows only the tabs the account holds.
    { to: '/admin/permissions', label: 'Permissions', icon: FiShield,
      // hasExplicitPermission already passes a Super Admin (and an exec in edit
      // mode) for any key, so they are not named here.
      anyExplicitPerm: ['leaveHierarchy.manage', 'regularizationHierarchy.manage', 'hierarchy.manage'],
      keywords: ['access', 'grants', 'capabilities', 'manager grant', 'hierarchy',
        'approval hierarchy', 'approval setup', 'who approves', 'ladder', 'chain'],
      tabs: [{ id: 'access', label: 'Module access', roles: ['SuperAdmin'] },
        { id: 'leave', label: 'Leave approvals', anyExplicitPerm: ['leaveHierarchy.manage'] },
        { id: 'regularization', label: 'Regularization approvals', anyExplicitPerm: ['regularizationHierarchy.manage', 'hierarchy.manage'] }] },
  ] },
  { group: 'Payroll & Salary', icon: TbCurrencyRupee, items: [
    { to: '/admin/payroll', label: 'Payroll', icon: TbCurrencyRupee, perm: 'payroll.manage',
      keywords: ['salary', 'payslip'] },
    // The release queue: employees ask for their payslip, HR checks and hands it over.
    { to: '/admin/payslip-requests', label: 'Payslip Requests', icon: TbReceipt, perm: 'payroll.manage',
      // Two queues on one page: what employees asked for, and the slips an HR
      // prepared for themselves, frozen until an executive sanctions them.
      badge: ['payslipRequest', 'selfPayslip'],
      tabs: [{ id: 'pending', label: 'Needs action' }, { id: 'released', label: 'Released' }] },
    { to: '/admin/salary-structures', label: 'Salary Structures', icon: FiSliders, perm: 'payroll.manage' },
    // Wears the salary changes waiting on a CEO/MD/Super Admin — 0 for HR, whose
    // requests are waiting on somebody else.
    { to: '/admin/payroll-run', label: 'Salary Revisions', icon: FiRepeat, perm: 'payroll.manage',
      badge: 'salaryChange',
      keywords: ['hike', 'hikes', 'increment', 'revise salary', 'ctc', 'salary approval', 'approve salary'] },
    { to: '/admin/loans', label: 'Loans & Advances', icon: FiCreditCard, perm: 'loans.manage', badge: 'loan' },
    { to: '/admin/declarations', label: 'Tax Declarations', icon: FiPercent, perm: 'declarations.manage',
      badge: 'declaration' },
    { to: '/admin/compliance', label: 'Compliance', icon: FiCheckCircle, perm: 'compliance.view',
      tabs: [{ id: 'pf', label: 'PF' }, { id: 'esi', label: 'ESI' }, { id: 'pt', label: 'PT' },
        { id: 'tds', label: 'TDS' }, { id: 'form16', label: 'Form 16' }] },
  ] },
  // Cashbook used to be a category of its own, which meant it rendered as a
  // bare section link with no icon (see the single-item branch in NavList).
  // Folded in with the other money-out modules so it gets a real nav row.
  // The Expense Claims row ("Expenses") was removed on 2026-09-26 (user ask):
  // staff record what they spend in their cashbook, which Employee Cashbook
  // below already reviews. The category keeps its name — that IS expenses.
  { group: 'Expenses & Cashbook', icon: FiShoppingBag, items: [
    { to: '/admin/cashbook', label: 'Company Accounts', icon: TbCashBanknote, perm: 'cashbook.manage',
      badge: 'voucher',
      keywords: ['cashbook', 'company cashbook', 'petty cash', 'voucher', 'cash account', 'tin'],
      tabs: [{ id: 'overview', label: 'Overview' }, { id: 'ledger', label: 'Ledger' }, { id: 'vouchers', label: 'Vouchers' },
        { id: 'accounts', label: 'Accounts' }, { id: 'categories', label: 'Categories' }, { id: 'reports', label: 'Reports' }] },
    // The per-employee side of the cashbook — advances people hold and the
    // expenses they file against them. (Formerly "Employee Khata".)
    // `sanctions` is listed even though only a SuperAdmin/CEO/MD can open it:
    // the page hides the tab from everyone else, but global search deep-links by
    // id and a tab missing from here is a tab nobody can be sent to. The order
    // matches TABS in pages/AdminKhata.jsx.
    { to: '/admin/khata', label: 'Employee Cashbook', icon: TbReceipt, perm: 'khata.manage',
      // ALL THREE of its queues, because they are three different questions on
      // one page: payouts waiting to be made, spending waiting to be confirmed
      // (both khata.manage), and advances waiting to be sanctioned (CEO/MD/
      // Backend). Three gates, one row — so one number.
      badge: ['khata', 'khataConfirm', 'khataSanction'],
      keywords: ['khata', 'khatabook', 'advance', 'advances', 'employee advances', 'udhar', 'cash ledger', 'book', 'books', 'cashbook'],
      tabs: [{ id: 'overview', label: 'Overview' }, { id: 'people', label: 'People' }, { id: 'ledger', label: 'Ledger' },
        { id: 'sanctions', label: 'Advance approvals', roles: ['SuperAdmin', 'CEO', 'MD'] },
        { id: 'approvals', label: 'Approvals' },
        { id: 'accounts', label: 'Accounts' }] },
    // CEO/MD have no employee portal, so their own cash account (advances they
    // take, expenses they file) lives here in the admin portal.
    { to: '/admin/my-khata', label: 'My Cashbook', icon: TbReceipt, roles: ['CEO', 'MD'],
      keywords: ['khata', 'advance', 'book', 'books', 'cashbook'] },
    // (Travel sat here too; removed from web and mobile 2026-09-26.)
  ] },
  // TWO UNRELATED INCENTIVES live here, and there will be more: the daily rolling
  // one the Boys department records for itself, and the billing team's, which is
  // not recorded in the portal at all — it is read out of the billing system.
  // What makes them one category is the POINTS: every incentive pays in the same
  // company-wide points, so the rate, the dashboard and the leaderboards beneath
  // them are shared no matter how many incentives sit above. Its own category
  // rather than a row under Payroll: an incentive is run by whoever supervises
  // the work — a standalone grant an ordinary supervisor can hold — and nothing
  // in it touches the payroll module. `keepGroup` keeps it a real dropdown even
  // when permissions leave it holding a single item (see NavList in Layout.jsx):
  // the collapsed form is labelled with the group name, and "Incentive" on its
  // own does not say which incentive.
  { group: 'Incentive', icon: FiRotateCw, keepGroup: true, items: [
    // What a point is worth. Its own tab because the figure is COMPANY-WIDE —
    // every incentive is paid in points and converted here — so it does not
    // belong inside whichever module happened to be built first. First in the
    // category because it is the thing every incentive under it depends on.
    { to: '/admin/incentive-points', label: 'Point Rate', icon: TbCurrencyRupee, perm: 'incentive.manage',
      keywords: ['point', 'points', 'rupee per point', 'rate', 'value', 'conversion', 'incentive'] },
    { to: '/admin/boys-incentive', label: 'Boys Incentive', icon: FiRotateCw, perm: 'incentive.manage',
      keywords: ['rolling', 'rollings', 'sheet', 'sheets', 'boys', 'picker', 'team leader', 'points', 'daily team', 'incentive', 'paid', 'deduction'],
      tabs: [{ id: 'entries', label: 'Daily teams' }, { id: 'summary', label: 'Per employee' },
        { id: 'points', label: 'Points per sheet' }] },
    // The billing team's incentive, which is counted in the billing system and
    // only READ here — no entry, no correction, no import (see the page). Listed
    // like any other incentive all the same: the points it produces go into the
    // same pool as the rolled ones.
    { to: '/admin/billing-incentive', label: 'Billing Incentive', icon: TbReceipt, perm: 'incentive.manage',
      keywords: ['billing', 'invoice', 'invoices', 'invoiced', 'units', 'ssl', 'ssl code', 'sales tracker', 'points', 'incentive', 'unmatched'] },
    // Every employee and the points they hold, across every incentive. It sits
    // BELOW the individual tabs in the list but spans all of them: points are one
    // company-wide pool, and this is where the company sees what it owes, credits
    // somebody extra and settles up.
    { to: '/admin/incentive-dashboard', label: 'Points Dashboard', icon: FiBarChart2, perm: 'incentive.manage',
      keywords: ['points', 'dashboard', 'credit', 'credit points', 'bonus', 'award', 'pay', 'payout', 'owed', 'balance', 'incentive', 'department'],
      tabs: [{ id: 'people', label: 'Everyone' }, { id: 'credits', label: 'Credits given' }] },
    // The standing itself, over every department. Gated on the ROLE rather than
    // `incentive.manage`, and on the same four as the leaderboard's own
    // unrestricted bench (canPayIncentive in middleware/authMiddleware.js): the
    // per-department curtain is for colleagues comparing earnings and does not
    // apply to the people who settle them. A tab supervisor who holds
    // `incentive.manage` is NOT one of them and reads the ranking on My
    // Incentive, under whatever rule their department has.
    { to: '/admin/incentive-board', label: 'Leaderboard', icon: FiAward,
      roles: ['SuperAdmin', 'HRManager', 'CEO', 'MD'],
      keywords: ['leaderboard', 'ranking', 'rank', 'standing', 'top', 'best', 'points', 'incentive', 'department', 'earned'] },
    // Who may see whose points on the EMPLOYEE leaderboard. Gated on the ROLE,
    // not on `incentive.manage`: both endpoints behind it are
    // restrictTo('SuperAdmin'), and what one department learns about another's
    // earnings is not a decision that belongs to whoever runs a tab.
    { to: '/admin/incentive-leaderboard', label: 'Leaderboard Access', icon: FiAward, roles: ['SuperAdmin'],
      keywords: ['leaderboard', 'ranking', 'rank', 'visibility', 'who can see', 'department', 'incentive', 'points'] },
  ] },
  { group: 'Hiring & Onboarding', icon: FiUserPlus, items: [
    { to: '/admin/recruitment', label: 'Recruitment', icon: FiUserPlus, anyPerm: ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews'] },
    // Candidates sent in by outside HR consultancies, split by the verdict of
    // the Round 1 the agency takes itself. Same gate as Recruitment — CEO/MD,
    // God and the Backend pass hasPermission, so they see it too.
    { to: '/admin/consultancy', label: 'Consultancy Candidates', icon: FiFilter,
      anyPerm: ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews'],
      keywords: ['consultancy', 'agency', 'placement', 'round 1', 'screening', 'shortlisted', 'cleared', 'rejected', 'candidate'] },
    // Openings an HR consultancy asked the company to create. HR with job
    // access, CEO/MD and the Backend accept (which opens the job) or reject;
    // the badge counts what is waiting on the reader.
    { to: '/admin/consultancy-jobs', label: 'Consultancy Job Requests', icon: FiInbox,
      anyPerm: ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews'], badge: 'jobRequest',
      keywords: ['consultancy', 'agency', 'job request', 'new opening', 'requested job', 'approve job'] },
    { to: '/admin/hiring-onboarding', label: 'Offers & Joining', icon: FiClipboard, perm: 'recruitment.candidates' },
    { to: '/admin/new-joinees', label: 'New Joinee Records', icon: FiUserCheck, perm: 'recruitment.candidates' },
    // The rounds HR assigned to THIS executive. CEO/MD have no employee portal,
    // so without this row a final round booked with them has nowhere to be read
    // or written up — the same reason /admin/my-khata exists.
    { to: '/admin/my-interviews', label: 'My Interviews', icon: FiVideo, roles: ['CEO', 'MD'],
      keywords: ['interview', 'interviews', 'panel', 'candidate', 'feedback', 'round', 'rounds'] },
    { to: '/admin/onboarding', label: 'Onboarding Checklist', icon: FiCheckSquare, perm: 'onboarding.manage' },
    // Probations due inside 30 days, or already past. The server decides which
    // ones those are (isConfirmationDue), so this number and the rows the table
    // flags are the same rows.
    { to: '/admin/confirmations', label: 'Confirmations', icon: FiShield, perm: 'lifecycle.manage',
      badge: 'confirmation' },
  ] },
  { group: 'Performance & Learning', icon: FiTrendingUp, items: [
    { to: '/admin/performance', label: 'Performance', icon: FiTrendingUp, perm: 'performance.manage' },
    { to: '/admin/review-cycles', label: 'Appraisals', icon: FiEdit, perm: 'performance.manage' },
    // Three queues, one number: joining requests, reported issues, comments to
    // moderate — all worked from the side panels of this one page.
    { to: '/admin/courses', label: 'Courses', icon: FiBook, perm: 'courses.manage', ld: true,
      badge: 'course' },
    { to: '/admin/training', label: 'Training', icon: FiBookOpen, perm: 'training.manage' },
  ] },
  { group: 'Projects & Resources', icon: FiFolder, items: [
    { to: '/admin/projects', label: 'Projects', icon: FiFolder, perm: 'projects.manage' },
    // NO `perm` — everybody can set a task, and everybody has tasks. What
    // `tasks.manage` buys is the All Tasks tab and the team dashboard, which
    // the page itself decides from GET /tasks/meta (2026-09-21 rework).
    // The separate Task Workflows page went with the workflow builder.
    //
    // SIMPLIFIED 2026-09-25 (user: "it is too much complicated now"). The page
    // is two piles — Assigned to me / Assigned by me, plus All tasks for
    // tasks.manage — with a filter, the five figures and a status dropdown on
    // every row. Kanban and Requests are gone; the report and the template
    // library are reached from the header. These ids are what `?tab=` accepts.
    { to: '/admin/tasks', label: 'Tasks', icon: FiList,
      badge: 'taskApproval',
      keywords: ['task', 'tasks', 'to do', 'todo', 'work', 'assignment', 'assign', 'delegate',
        'transfer', 'overdue', 'review', 'approve', 'reject', 'submit', 'completed',
        'assigned to me', 'assigned by me', 'assign myself', 'progress', 'piece', 'pieces',
        'subtask', 'template', 'templates', 'recurring', 'repeat', 'reminder', 'voice note',
        'report', 'dashboard', 'points'],
      tabs: [{ id: 'mine', label: 'Assigned to me' }, { id: 'delegated', label: 'Assigned by me' },
        { id: 'all', label: 'All tasks' }, { id: 'report', label: 'Report' },
        { id: 'templates', label: 'Templates' }] },
    { to: '/admin/documents', label: 'Documents', icon: FiFile, perm: 'documents.manage', badge: 'docswap' },
    // Items employees asked to hand back from My Assets, waiting on an answer.
    { to: '/admin/assets', label: 'Assets', icon: FiPackage, perm: 'assets.manage',
      badge: 'assetReturn',
      keywords: ['asset return', 'return request', 'hand back', 'take back'],
      tabs: [{ id: 'assets', label: 'By asset' }, { id: 'employees', label: 'By employee' }, { id: 'assignments', label: 'Assignments' },
        { id: 'returns', label: 'Return requests' }] },
  ] },
  { group: 'Communication & Culture', icon: FiVolume2, items: [
    { to: '/admin/calendar', label: 'Calendar', icon: FiCalendar, highlight: true,
      keywords: ['calendar', 'month', 'deadline', 'deadlines', 'task deadline', 'holiday', 'event', 'birthday', 'reminder'] },
    { to: '/admin/announcements', label: 'Announcements', icon: FiVolume2, perm: 'announcements.manage' },
    { to: '/admin/events', label: 'Events', icon: FiFlag, perm: 'events.manage' },
    { to: '/admin/rnr', label: 'Rewards & Recognition', icon: FiAward, perm: 'announcements.manage' },
    { to: '/admin/surveys', label: 'Surveys', icon: FiPieChart, perm: 'surveys.manage' },
    { to: '/admin/templates', label: 'Email & Letter Templates', icon: FiEdit3,
      // Two grants share this page — the letter wording and the letterhead
      // itself — and either one on its own is enough to have something to do here.
      anyPerm: ['templates.manage', 'branding.manage'],
      tabs: [{ id: 'templates', label: 'Templates', perm: 'templates.manage' },
        { id: 'branding', label: 'Logo & signatures', perm: 'branding.manage' }] },
    // Push reminder schedule — SuperAdmin-only, matching the server, which
    // ignores the reminder block from anyone else.
    { to: '/admin/push-notifications', label: 'Push Notification', icon: FiBell, roles: ['SuperAdmin'] },
    // Which Android build every phone is offered. SuperAdmin-only, matching the
    // server: publishing decides what installs on company devices.
    { to: '/admin/app-release', label: 'App Release', icon: FiSmartphone, roles: ['SuperAdmin'] },
  ] },
  { group: 'Reports & Audit', icon: FiBarChart2, items: [
    { to: '/admin/analytics', label: 'Analytics', icon: FiBarChart2, perm: 'analytics.view' },
    // Who is using the portal right now, and ending a session. Backend-only by
    // ROLE, matching the server — signing somebody out of every device they
    // hold is not part of "manage users".
    { to: '/admin/sessions', label: 'Signed in', icon: FiActivity, roles: ['SuperAdmin'],
      keywords: ['session', 'logged in', 'log out', 'sign out', 'online'] },
    // Credential state for every account + setting somebody a new password.
    // Backend-only by ROLE for the same reason as Signed in and the Audit Log: a
    // read-only exec must not be handed the whole directory's login state.
    { to: '/admin/account-security', label: 'Passwords & Access', icon: FiLock, roles: ['SuperAdmin'],
      keywords: ['password', 'reset password', 'credentials', 'forgot', 'locked out', 'login'] },
    // Who is on which app build, and who has never installed it at all.
    // Backend-only by ROLE, like its neighbours: it is a device inventory.
    { to: '/admin/app-versions', label: 'App Versions', icon: FiList, roles: ['SuperAdmin'],
      keywords: ['app version', 'update', 'apk', 'phone', 'mobile', 'who has the app'] },
    { to: '/admin/audit-log', label: 'Audit Log', icon: FiFileText, roles: ['SuperAdmin'] },
    { to: '/admin/chat-export', label: 'Chat Export', icon: FiMessageSquare, roles: ['SuperAdmin'], feature: 'chat' },
  ] },
  { group: 'My Account & Requests', icon: FiKey, items: [
    { to: '/admin/account', label: 'My Account', icon: FiKey },
    { to: '/admin/change-requests', label: 'Change Requests', icon: FiEdit3, badge: 'change' },
    { to: '/admin/complaints', label: 'Complaints', icon: FiAlertTriangle, badge: 'complaint' },
    { to: '/admin/password-resets', label: 'Password Resets', icon: FiKey, perm: 'users.manage',
      badge: 'passwordReset' },
  ] },
  { group: 'Exits', icon: FiLogOut, items: [
    // Resignations nobody has decided yet. NOT the ones serving notice — that
    // runs for a month by design, and a badge nobody can clear stops being read.
    { to: '/admin/exits', label: 'Exits', icon: FiLogOut, perm: 'exit.manage',
      badge: 'exit',
      keywords: ['resignation', 'clearance', 'relieving', 'offboarding'] },
  ] },
  // Last entry in the sidebar. A single-item group renders as a plain top-level
  // link labelled with the group name (see NavList in Layout.jsx), so this shows
  // as one "Help" link rather than a dropdown.
  { group: 'Help', icon: FiHelpCircle, items: [
    { to: '/admin/how-to-use', label: 'Help', icon: FiHelpCircle },
    // Its own admin-portal route rather than a link into My Portal: following a
    // nav item should not silently switch which portal you are in.
    { to: '/admin/mobile-app', label: 'Mobile App', icon: FiSmartphone,
      keywords: ['apk', 'android', 'download app', 'install'] },
  ] },
];

// HR L&D (LDManager) is an LMS-only admin: they enter the admin portal but see
// only the Courses page. A flat, single-item nav keeps the sidebar unambiguous.
export const ldNav = [
  { to: '/admin/courses', label: 'Courses', end: true, icon: FiBook, badge: 'course' },
];

// Account Manager (AccountsManager) is a cashbook-only admin: they enter the
// admin portal but see only the Cashbook page. Same flat-nav pattern as ldNav.
export const accountsNav = [
  { to: '/admin/cashbook', label: 'Company Accounts', end: true, icon: TbCashBanknote, badge: 'voucher',
    keywords: ['cashbook', 'company cashbook', 'petty cash', 'voucher', 'cash account'] },
  // (Expense Claims used to sit here too; removed 2026-09-26.)
  // Handing cash to staff is the other half of the accounts job. Global search
  // reads whichever nav the signed-in role was given, so the aliases have to be
  // repeated here or an Accounts Manager typing "cashbook" finds only the
  // company cashbook and not the one their own team runs.
  { to: '/admin/khata', label: 'Employee Cashbook', end: true, icon: TbReceipt,
    badge: ['khata', 'khataConfirm', 'khataSanction'],
    keywords: ['khata', 'khatabook', 'advance', 'advances', 'employee advances', 'udhar', 'book', 'books', 'cashbook'] },
];

// An HR Consultancy is an OUTSIDE agency: it enters the admin shell and sees one
// page — its own candidates, where it adds them and takes their Round 1. The
// server refuses it everything else, so nothing else is offered.
export const consultancyNav = [
  { to: '/admin/consultancy', label: 'My Candidates', end: true, icon: FiUserPlus,
    keywords: ['candidate', 'candidates', 'add candidate', 'round 1', 'interview', 'shortlist', 'join'] },
  // The company's open jobs, and the new openings this agency has asked for.
  { to: '/admin/consultancy-jobs', label: 'Job Openings', end: true, icon: FiBriefcase,
    keywords: ['jobs', 'openings', 'request job', 'new opening', 'vacancy'] },
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
    // Any employee can be somebody's manager in the org chart, which is why this
    // row is not role-gated — and why it earns the same red count the admin
    // portal's inbox wears. Both open the same reporting-chain queue.
    { to: '/employee/approvals', label: 'Approvals', icon: FiCheckSquare, badge: 'mine' },
    { to: '/employee/team', label: 'My Team', icon: FiUsers, roles: ['Manager'] },
    { to: '/employee/interviews', label: 'My Interviews', icon: FiUserCheck },
    { to: '/employee/onboarding', label: 'Onboarding', icon: FiClipboard },
    { to: '/employee/org-chart', label: 'Org Chart', icon: FiGitBranch },
  ] },
  { group: 'Payroll & Expenses', icon: TbCurrencyRupee, items: [
    { to: '/employee/payslips', label: 'Payslips', icon: TbCurrencyRupee,
      keywords: ['salary', 'slip'] },
    // Four self-service ways in have been taken off this menu: Expenses, then
    // Cash Vouchers, Travel and Tax Declaration (2026-09-01). The first three
    // because employees file what they spend through My Cashbook, which covers
    // the same ground against their advance; the declaration because it is
    // collected by HR rather than self-served — it stays under Payroll &
    // Finance in the admin portal (`declarations.manage`), which is also where
    // a CEO/MD reads it. Vouchers and the declaration keep their route and page
    // — admin queues still read what was already filed, and a saved link still
    // opens. Expense Claims and Travel went further on 2026-09-26: removed from
    // web and mobile entirely, filing page and review queue both.
    { to: '/employee/loans', label: 'Loans & Advances', icon: FiCreditCard },
    { to: '/employee/khata', label: 'My Cashbook', icon: TbReceipt,
      keywords: ['khata', 'khatabook', 'advance', 'udhar', 'expense', 'book', 'books', 'cashbook'] },
    { to: '/employee/cashbook-manage', label: 'Company Accounts', icon: TbCashBanknote, perm: 'cashbook.manage',
      keywords: ['cashbook', 'company cashbook', 'petty cash', 'voucher', 'cash account'] },
    // The Employee Cashbook admin surface, for standalone-grant holders with no admin portal.
    { to: '/employee/khata-manage', label: 'Employee Cashbook', icon: TbCashBanknote, perm: 'khata.manage',
      keywords: ['khata', 'khatabook', 'advance', 'advances', 'employee advances', 'udhar', 'book', 'books', 'cashbook'] },
    // For whoever decides loans and advances (User.loansAccess): the
    // queue of everyone's requests, named apart from the "Loans & Advances" row
    // above, which is only what this person has borrowed themselves.
    { to: '/employee/loans-manage', label: 'Loan Approvals', icon: FiCreditCard, perm: 'loans.manage',
      keywords: ['loan', 'loans', 'advance', 'advances', 'emi', 'approve', 'sanction'] },
  ] },
  // Its own category, exactly as in the admin portal (user decision
  // 2026-09-10). Whoever holds a role in an incentive sees this whether or not
  // they have an admin portal at all, and burying it under Payroll made it read
  // as something to do with their own pay rather than a job they run.
  { group: 'Incentive', icon: FiRotateCw, keepGroup: true, items: [
    // MY OWN points — the one row in this group that is NOT gated. Everybody
    // who can earn points can read their own, which is the whole reason the
    // page exists; the rows under it are for whoever RUNS an incentive.
    { to: '/employee/my-incentive', label: 'My Incentive', icon: FiAward,
      keywords: ['incentive', 'points', 'my points', 'leaderboard', 'rank', 'ranking', 'unpaid', 'earned', 'rolling', 'standing'],
      tabs: [{ id: 'points', label: 'My points' }, { id: 'board', label: 'Leaderboard' }] },
    { to: '/employee/incentive-points', label: 'Point Rate', icon: TbCurrencyRupee, perm: 'incentive.manage',
      keywords: ['point', 'points', 'rupee per point', 'rate', 'value', 'incentive'] },
    { to: '/employee/boys-incentive', label: 'Boys Incentive', icon: FiRotateCw, perm: 'incentive.manage',
      keywords: ['rolling', 'rollings', 'sheet', 'sheets', 'boys', 'picker', 'team leader', 'points', 'incentive', 'paid', 'deduction'] },
    // The billing team's, read out of the billing system rather than recorded
    // here — the same page the admin portal mounts, for a grant holder with no
    // admin portal of their own.
    { to: '/employee/billing-incentive', label: 'Billing Incentive', icon: TbReceipt, perm: 'incentive.manage',
      keywords: ['billing', 'invoice', 'invoices', 'invoiced', 'units', 'ssl', 'ssl code', 'sales tracker', 'points', 'incentive', 'unmatched'] },
    { to: '/employee/incentive-dashboard', label: 'Points Dashboard', icon: FiBarChart2, perm: 'incentive.manage',
      keywords: ['points', 'dashboard', 'credit', 'credit points', 'bonus', 'award', 'pay', 'payout', 'owed', 'balance', 'incentive', 'department'],
      tabs: [{ id: 'people', label: 'Everyone' }, { id: 'credits', label: 'Credits given' }] },
  ] },
  { group: 'Performance & Learning', icon: FiTrendingUp, items: [
    { to: '/employee/goals', label: 'Goals', icon: FiTarget },
    { to: '/employee/reviews', label: 'My Reviews', icon: FiEdit },
    { to: '/employee/learning', label: 'Learning', icon: FiBookOpen },
    // Instructor-led training, as opposed to the LMS courses above it. Shown to
    // whoever holds `training.manage` — which a SuperAdmin can hand to any
    // account, whatever its role, with the standalone Training switch. They can
    // book sessions from here, not just read them.
    { to: '/employee/training', label: 'Training', icon: FiBookOpen, perm: 'training.manage',
      keywords: ['training', 'session', 'workshop', 'trainer', 'programme', 'program', 'schedule'] },
  ] },
  { group: 'Projects & Resources', icon: FiFolder, items: [
    // The SAME badge the admin row wears. It is a personal count — your own
    // open tasks plus anything waiting on your word — and since 2026-09-22 it
    // is answered by /approvals/count, which every portal polls. Without it the
    // top bar's Tasks pill showed a red 3 and the row three inches below it
    // showed nothing, for the same page.
    { to: '/employee/tasks', label: 'Tasks', icon: FiList,
      badge: 'taskApproval',
      keywords: ['task', 'tasks', 'to do', 'todo', 'my work', 'assignment', 'assign', 'submit',
        'approve', 'reject', 'overdue', 'deadline', 'assigned to me', 'assigned by me', 'assign myself'],
      tabs: [{ id: 'mine', label: 'Assigned to me' }, { id: 'delegated', label: 'Assigned by me' }] },
    { to: '/employee/documents', label: 'Documents', icon: FiFile },
    { to: '/employee/assets', label: 'Assets', icon: FiPackage },
    // The register, for holders of the standalone Assets grant with no admin
    // portal. Named apart from the self-service "Assets" row above, which
    // lists only what is allotted to me. Wears the same return-request count as
    // the admin row: Layout asks for the HR-wide tally in My Portal for exactly
    // this grant (see the nav-count poll there).
    { to: '/employee/assets-manage', label: 'Manage Assets', icon: FiPackage, perm: 'assets.manage',
      badge: 'assetReturn',
      tabs: [{ id: 'assets', label: 'By asset' }, { id: 'employees', label: 'By employee' }, { id: 'assignments', label: 'Assignments' },
        { id: 'returns', label: 'Return requests' }] },
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
    { to: '/employee/exit', label: 'Resignation', icon: FiLogOut, danger: true,
      keywords: ['exit', 'notice period', 'quit'] },
  ] },
  // Last entry in the sidebar — see the note on the admin Help group above.
  { group: 'Help', icon: FiHelpCircle, items: [
    { to: '/employee/how-to-use', label: 'Help', icon: FiHelpCircle },
    // The app is sideloaded, so there is no store page to send anyone to and
    // nothing on a phone that finds a new build by itself — this is where staff
    // install it and where they come back to update.
    { to: '/employee/mobile-app', label: 'Mobile App', icon: FiSmartphone,
      keywords: ['apk', 'android', 'download app', 'install'] },
  ] },
];
