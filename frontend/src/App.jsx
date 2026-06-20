import { lazy, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useThemeStore } from './store/themeStore';
// Public auth/entry pages stay eager (they render outside the app shell).
import Login from './pages/Login.jsx';
import ExitFeedback from './pages/ExitFeedback.jsx';
import ApplyForm from './pages/ApplyForm.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import { useAuthStore } from './store/authStore';

// In-app pages are lazy-loaded — the Layout shows a skeleton (Suspense) while
// each page's chunk loads, and this code-splits the bundle.
const AdminDashboard = lazy(() => import('./pages/AdminDashboard.jsx'));
const AdminEmployees = lazy(() => import('./pages/AdminEmployees.jsx'));
const AdminEmployeeDetail = lazy(() => import('./pages/AdminEmployeeDetail.jsx'));
const AdminPayroll = lazy(() => import('./pages/AdminPayroll.jsx'));
const AdminLeave = lazy(() => import('./pages/AdminLeave.jsx'));
const AdminAttendance = lazy(() => import('./pages/AdminAttendance.jsx'));
const AdminDocuments = lazy(() => import('./pages/AdminDocuments.jsx'));
const AdminExit = lazy(() => import('./pages/AdminExit.jsx'));
const EmployeeDashboard = lazy(() => import('./pages/EmployeeDashboard.jsx'));
const EmployeePayslips = lazy(() => import('./pages/EmployeePayslips.jsx'));
const EmployeeLeave = lazy(() => import('./pages/EmployeeLeave.jsx'));
const EmployeeAttendance = lazy(() => import('./pages/EmployeeAttendance.jsx'));
const EmployeeDocuments = lazy(() => import('./pages/EmployeeDocuments.jsx'));
const EmployeeExit = lazy(() => import('./pages/EmployeeExit.jsx'));
const EmployeeProfile = lazy(() => import('./pages/EmployeeProfile.jsx'));
const EmployeeComplaints = lazy(() => import('./pages/EmployeeComplaints.jsx'));
const AdminComplaints = lazy(() => import('./pages/AdminComplaints.jsx'));
const EmployeeAccount = lazy(() => import('./pages/EmployeeAccount.jsx'));
const AdminChangeRequests = lazy(() => import('./pages/AdminChangeRequests.jsx'));
const Calendar = lazy(() => import('./pages/Calendar.jsx'));
const AdminHolidays = lazy(() => import('./pages/AdminHolidays.jsx'));
const AdminEvents = lazy(() => import('./pages/AdminEvents.jsx'));
const AdminDepartments = lazy(() => import('./pages/AdminDepartments.jsx'));
const AdminOverview = lazy(() => import('./pages/AdminOverview.jsx'));
const AdminProjects = lazy(() => import('./pages/AdminProjects.jsx'));
const AdminTasks = lazy(() => import('./pages/AdminTasks.jsx'));
const AdminRecruitment = lazy(() => import('./pages/AdminRecruitment.jsx'));
const AdminAssets = lazy(() => import('./pages/AdminAssets.jsx'));
const AdminPerformance = lazy(() => import('./pages/AdminPerformance.jsx'));
const AdminTraining = lazy(() => import('./pages/AdminTraining.jsx'));
const EmployeeTasks = lazy(() => import('./pages/EmployeeTasks.jsx'));
const EmployeeAssets = lazy(() => import('./pages/EmployeeAssets.jsx'));
const EmployeeGoals = lazy(() => import('./pages/EmployeeGoals.jsx'));
const AdminExpenses = lazy(() => import('./pages/AdminExpenses.jsx'));
const EmployeeExpenses = lazy(() => import('./pages/EmployeeExpenses.jsx'));
const AdminOnboarding = lazy(() => import('./pages/AdminOnboarding.jsx'));
const EmployeeOnboarding = lazy(() => import('./pages/EmployeeOnboarding.jsx'));
const AdminAnnouncements = lazy(() => import('./pages/AdminAnnouncements.jsx'));
const EmployeeAnnouncements = lazy(() => import('./pages/EmployeeAnnouncements.jsx'));
const AdminKnowledgeBase = lazy(() => import('./pages/AdminKnowledgeBase.jsx'));
const EmployeeKnowledgeBase = lazy(() => import('./pages/EmployeeKnowledgeBase.jsx'));
const EmployeeRecognition = lazy(() => import('./pages/EmployeeRecognition.jsx'));
const AdminOrgMasters = lazy(() => import('./pages/AdminOrgMasters.jsx'));
const AdminOrgChart = lazy(() => import('./pages/AdminOrgChart.jsx'));
const AdminConfirmations = lazy(() => import('./pages/AdminConfirmations.jsx'));
const AdminRoster = lazy(() => import('./pages/AdminRoster.jsx'));
const EmployeeShifts = lazy(() => import('./pages/EmployeeShifts.jsx'));
const AdminRegularizations = lazy(() => import('./pages/AdminRegularizations.jsx'));
const EmployeeRegularizations = lazy(() => import('./pages/EmployeeRegularizations.jsx'));
const AdminCompOff = lazy(() => import('./pages/AdminCompOff.jsx'));
const EmployeeCompOff = lazy(() => import('./pages/EmployeeCompOff.jsx'));
const AdminSalaryStructures = lazy(() => import('./pages/AdminSalaryStructures.jsx'));
const AdminLoans = lazy(() => import('./pages/AdminLoans.jsx'));
const EmployeeLoans = lazy(() => import('./pages/EmployeeLoans.jsx'));
const AdminInvestmentDeclarations = lazy(() => import('./pages/AdminInvestmentDeclarations.jsx'));
const EmployeeInvestmentDeclaration = lazy(() => import('./pages/EmployeeInvestmentDeclaration.jsx'));
const AdminCompliance = lazy(() => import('./pages/AdminCompliance.jsx'));
const AdminSurveys = lazy(() => import('./pages/AdminSurveys.jsx'));
const EmployeeSurveys = lazy(() => import('./pages/EmployeeSurveys.jsx'));
const AdminTravel = lazy(() => import('./pages/AdminTravel.jsx'));
const EmployeeTravel = lazy(() => import('./pages/EmployeeTravel.jsx'));
const AdminCourses = lazy(() => import('./pages/AdminCourses.jsx'));
const EmployeeLearning = lazy(() => import('./pages/EmployeeLearning.jsx'));
const AdminReviewCycles = lazy(() => import('./pages/AdminReviewCycles.jsx'));
const EmployeeReviews = lazy(() => import('./pages/EmployeeReviews.jsx'));
const AdminAnalytics = lazy(() => import('./pages/AdminAnalytics.jsx'));

const adminNav = [
  { to: '/admin/dashboard', label: 'Dashboard', icon: '📊' },
  { to: '/admin/users', label: 'Users', icon: '👥' },
  { to: '/admin/employees', label: 'Employees', icon: '🧑‍💼' },
  { to: '/admin/departments', label: 'Departments', icon: '🏢' },
  { to: '/admin/org-masters', label: 'Org Masters', icon: '🗂️' },
  { to: '/admin/org-chart', label: 'Org Chart', icon: '🌳' },
  { to: '/admin/onboarding', label: 'Onboarding', icon: '🚀' },
  { to: '/admin/confirmations', label: 'Confirmations', icon: '🛡️' },
  { to: '/admin/attendance', label: 'Attendance', icon: '🕒' },
  { to: '/admin/roster', label: 'Shifts & Roster', icon: '📆' },
  { to: '/admin/regularizations', label: 'Regularization', icon: '🛠️' },
  { to: '/admin/payroll', label: 'Payroll', icon: '💰' },
  { to: '/admin/salary-structures', label: 'Salary Structures', icon: '🧮' },
  { to: '/admin/loans', label: 'Loans & Advances', icon: '🏦' },
  { to: '/admin/declarations', label: 'Tax Declarations', icon: '🧾' },
  { to: '/admin/compliance', label: 'Compliance', icon: '⚖️' },
  { to: '/admin/leave', label: 'Leave', icon: '🌴' },
  { to: '/admin/compoff', label: 'Comp-off', icon: '🔁' },
  { to: '/admin/expenses', label: 'Expenses', icon: '💸' },
  { to: '/admin/travel', label: 'Travel', icon: '✈️' },
  { to: '/admin/documents', label: 'Documents', icon: '📄' },
  { to: '/admin/projects', label: 'Projects', icon: '📁' },
  { to: '/admin/tasks', label: 'Tasks', icon: '✅' },
  { to: '/admin/recruitment', label: 'Recruitment', icon: '🧲' },
  { to: '/admin/assets', label: 'Assets', icon: '💻' },
  { to: '/admin/performance', label: 'Performance', icon: '📈' },
  { to: '/admin/review-cycles', label: 'Appraisals', icon: '📝' },
  { to: '/admin/training', label: 'Training', icon: '🎓' },
  { to: '/admin/courses', label: 'Courses (LMS)', icon: '📖' },
  { to: '/admin/analytics', label: 'Analytics', icon: '📊' },
  { to: '/admin/recognition', label: 'Recognition', icon: '🏆' },
  { to: '/admin/announcements', label: 'Announcements', icon: '📢' },
  { to: '/admin/surveys', label: 'Surveys', icon: '🗳️' },
  { to: '/admin/complaints', label: 'Complaints', icon: '⚠️' },
  { to: '/admin/change-requests', label: 'Change Requests', icon: '✏️' },
  { to: '/admin/account', label: 'My Account', icon: '🔐' },
  { to: '/admin/knowledge-base', label: 'Knowledge Base', icon: '📚' },
  { to: '/admin/holidays', label: 'Holidays', icon: '🎉' },
  { to: '/admin/events', label: 'Events', icon: '📣' },
  { to: '/admin/calendar', label: 'Calendar', icon: '📅' },
  { to: '/admin/exits', label: 'Exits', icon: '🚪' },
];

const employeeNav = [
  { to: '/employee', label: 'Overview', end: true, icon: '🏠' },
  { to: '/employee/org-chart', label: 'Org Chart', icon: '🌳' },
  { to: '/employee/onboarding', label: 'Onboarding', icon: '🚀' },
  { to: '/employee/attendance', label: 'Attendance', icon: '🕒' },
  { to: '/employee/shifts', label: 'My Shifts', icon: '📆' },
  { to: '/employee/regularizations', label: 'Regularization', icon: '🛠️' },
  { to: '/employee/payslips', label: 'Payslips', icon: '💰' },
  { to: '/employee/loans', label: 'Loans & Advances', icon: '🏦' },
  { to: '/employee/declaration', label: 'Tax Declaration', icon: '🧾' },
  { to: '/employee/leave', label: 'Leave', icon: '🌴' },
  { to: '/employee/compoff', label: 'Comp-off', icon: '🔁' },
  { to: '/employee/expenses', label: 'Expenses', icon: '💸' },
  { to: '/employee/travel', label: 'Travel', icon: '✈️' },
  { to: '/employee/documents', label: 'Documents', icon: '📄' },
  { to: '/employee/tasks', label: 'Tasks', icon: '✅' },
  { to: '/employee/assets', label: 'Assets', icon: '💻' },
  { to: '/employee/goals', label: 'Goals', icon: '🎯' },
  { to: '/employee/reviews', label: 'My Reviews', icon: '📝' },
  { to: '/employee/learning', label: 'Learning', icon: '📖' },
  { to: '/employee/recognition', label: 'Recognition', icon: '🏆' },
  { to: '/employee/announcements', label: 'Announcements', icon: '📢' },
  { to: '/employee/surveys', label: 'Surveys', icon: '🗳️' },
  { to: '/employee/calendar', label: 'Calendar', icon: '📅' },
  { to: '/employee/complaints', label: 'Complaints', icon: '⚠️' },
  { to: '/employee/knowledge-base', label: 'Help / KB', icon: '📚' },
  { to: '/employee/exit', label: 'Resignation', icon: '🚪', danger: true },
  { to: '/employee/profile', label: 'Profile', icon: '👤' },
  { to: '/employee/account', label: 'Account & Requests', icon: '🔐' },
];

function RootRedirect() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'Employee' ? '/employee' : '/admin'} replace />;
}

export default function App() {
  const mode = useThemeStore((s) => s.mode);
  const role = useAuthStore((s) => s.user?.role);

  // Apply dark/light class and the per-role accent attribute to <html>.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    if (role) root.setAttribute('data-role', role);
    else root.removeAttribute('data-role');
  }, [mode, role]);

  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<Login />} />

      {/* Public — ex-employees access via tokenised link in email */}
      <Route path="/exit-feedback/:token" element={<ExitFeedback />} />

      {/* Public — job application form (shareable link) */}
      <Route path="/apply/:jobId" element={<ApplyForm />} />

      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={['SuperAdmin', 'HRManager']}>
            <Layout navItems={adminNav} sectionTitle="Admin" />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<AdminOverview />} />
        <Route path="users" element={<AdminDashboard />} />
        <Route path="employees" element={<AdminEmployees />} />
        <Route path="employees/:id" element={<AdminEmployeeDetail />} />
        <Route path="departments" element={<AdminDepartments />} />
        <Route path="org-masters" element={<AdminOrgMasters />} />
        <Route path="org-chart" element={<AdminOrgChart />} />
        <Route path="onboarding" element={<AdminOnboarding />} />
        <Route path="confirmations" element={<AdminConfirmations />} />
        <Route path="attendance" element={<AdminAttendance />} />
        <Route path="roster" element={<AdminRoster />} />
        <Route path="regularizations" element={<AdminRegularizations />} />
        <Route path="payroll" element={<AdminPayroll />} />
        <Route path="salary-structures" element={<AdminSalaryStructures />} />
        <Route path="loans" element={<AdminLoans />} />
        <Route path="declarations" element={<AdminInvestmentDeclarations />} />
        <Route path="compliance" element={<AdminCompliance />} />
        <Route path="leave" element={<AdminLeave />} />
        <Route path="compoff" element={<AdminCompOff />} />
        <Route path="expenses" element={<AdminExpenses />} />
        <Route path="travel" element={<AdminTravel />} />
        <Route path="documents" element={<AdminDocuments />} />
        <Route path="projects" element={<AdminProjects />} />
        <Route path="tasks" element={<AdminTasks />} />
        <Route path="recruitment" element={<AdminRecruitment />} />
        <Route path="assets" element={<AdminAssets />} />
        <Route path="performance" element={<AdminPerformance />} />
        <Route path="review-cycles" element={<AdminReviewCycles />} />
        <Route path="training" element={<AdminTraining />} />
        <Route path="courses" element={<AdminCourses />} />
        <Route path="analytics" element={<AdminAnalytics />} />
        <Route path="recognition" element={<EmployeeRecognition />} />
        <Route path="announcements" element={<AdminAnnouncements />} />
        <Route path="surveys" element={<AdminSurveys />} />
        <Route path="complaints" element={<AdminComplaints />} />
        <Route path="change-requests" element={<AdminChangeRequests />} />
        <Route path="account" element={<EmployeeAccount />} />
        <Route path="knowledge-base" element={<AdminKnowledgeBase />} />
        <Route path="holidays" element={<AdminHolidays />} />
        <Route path="events" element={<AdminEvents />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="exits" element={<AdminExit />} />
      </Route>

      <Route
        path="/employee"
        element={
          <ProtectedRoute roles={['Employee', 'HRManager']}>
            <Layout navItems={employeeNav} sectionTitle="My Portal" />
          </ProtectedRoute>
        }
      >
        <Route index element={<EmployeeDashboard />} />
        <Route path="org-chart" element={<AdminOrgChart />} />
        <Route path="onboarding" element={<EmployeeOnboarding />} />
        <Route path="attendance" element={<EmployeeAttendance />} />
        <Route path="shifts" element={<EmployeeShifts />} />
        <Route path="regularizations" element={<EmployeeRegularizations />} />
        <Route path="payslips" element={<EmployeePayslips />} />
        <Route path="loans" element={<EmployeeLoans />} />
        <Route path="declaration" element={<EmployeeInvestmentDeclaration />} />
        <Route path="leave" element={<EmployeeLeave />} />
        <Route path="compoff" element={<EmployeeCompOff />} />
        <Route path="expenses" element={<EmployeeExpenses />} />
        <Route path="travel" element={<EmployeeTravel />} />
        <Route path="documents" element={<EmployeeDocuments />} />
        <Route path="tasks" element={<EmployeeTasks />} />
        <Route path="assets" element={<EmployeeAssets />} />
        <Route path="goals" element={<EmployeeGoals />} />
        <Route path="reviews" element={<EmployeeReviews />} />
        <Route path="learning" element={<EmployeeLearning />} />
        <Route path="recognition" element={<EmployeeRecognition />} />
        <Route path="announcements" element={<EmployeeAnnouncements />} />
        <Route path="surveys" element={<EmployeeSurveys />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="complaints" element={<EmployeeComplaints />} />
        <Route path="knowledge-base" element={<EmployeeKnowledgeBase />} />
        <Route path="exit" element={<EmployeeExit />} />
        <Route path="profile" element={<EmployeeProfile />} />
        <Route path="account" element={<EmployeeAccount />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
