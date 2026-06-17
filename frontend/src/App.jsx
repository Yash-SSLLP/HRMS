import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useThemeStore } from './store/themeStore';
import Login from './pages/Login.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import AdminEmployees from './pages/AdminEmployees.jsx';
import AdminEmployeeDetail from './pages/AdminEmployeeDetail.jsx';
import AdminPayroll from './pages/AdminPayroll.jsx';
import AdminLeave from './pages/AdminLeave.jsx';
import AdminAttendance from './pages/AdminAttendance.jsx';
import AdminDocuments from './pages/AdminDocuments.jsx';
import AdminExit from './pages/AdminExit.jsx';
import EmployeeDashboard from './pages/EmployeeDashboard.jsx';
import EmployeePayslips from './pages/EmployeePayslips.jsx';
import EmployeeLeave from './pages/EmployeeLeave.jsx';
import EmployeeAttendance from './pages/EmployeeAttendance.jsx';
import EmployeeDocuments from './pages/EmployeeDocuments.jsx';
import EmployeeExit from './pages/EmployeeExit.jsx';
import EmployeeProfile from './pages/EmployeeProfile.jsx';
import ExitFeedback from './pages/ExitFeedback.jsx';
import EmployeeComplaints from './pages/EmployeeComplaints.jsx';
import AdminComplaints from './pages/AdminComplaints.jsx';
import Calendar from './pages/Calendar.jsx';
import AdminHolidays from './pages/AdminHolidays.jsx';
import AdminEvents from './pages/AdminEvents.jsx';
import AdminDepartments from './pages/AdminDepartments.jsx';
import AdminOverview from './pages/AdminOverview.jsx';
import AdminProjects from './pages/AdminProjects.jsx';
import AdminTasks from './pages/AdminTasks.jsx';
import AdminRecruitment from './pages/AdminRecruitment.jsx';
import AdminAssets from './pages/AdminAssets.jsx';
import AdminPerformance from './pages/AdminPerformance.jsx';
import AdminTraining from './pages/AdminTraining.jsx';
import EmployeeTasks from './pages/EmployeeTasks.jsx';
import EmployeeAssets from './pages/EmployeeAssets.jsx';
import EmployeeGoals from './pages/EmployeeGoals.jsx';
import AdminExpenses from './pages/AdminExpenses.jsx';
import EmployeeExpenses from './pages/EmployeeExpenses.jsx';
import AdminOnboarding from './pages/AdminOnboarding.jsx';
import EmployeeOnboarding from './pages/EmployeeOnboarding.jsx';
import AdminAnnouncements from './pages/AdminAnnouncements.jsx';
import EmployeeAnnouncements from './pages/EmployeeAnnouncements.jsx';
import AdminKnowledgeBase from './pages/AdminKnowledgeBase.jsx';
import EmployeeKnowledgeBase from './pages/EmployeeKnowledgeBase.jsx';
import EmployeeRecognition from './pages/EmployeeRecognition.jsx';
import AdminOrgMasters from './pages/AdminOrgMasters.jsx';
import AdminOrgChart from './pages/AdminOrgChart.jsx';
import AdminConfirmations from './pages/AdminConfirmations.jsx';
import AdminRoster from './pages/AdminRoster.jsx';
import EmployeeShifts from './pages/EmployeeShifts.jsx';
import AdminRegularizations from './pages/AdminRegularizations.jsx';
import EmployeeRegularizations from './pages/EmployeeRegularizations.jsx';
import AdminCompOff from './pages/AdminCompOff.jsx';
import EmployeeCompOff from './pages/EmployeeCompOff.jsx';
import AdminSalaryStructures from './pages/AdminSalaryStructures.jsx';
import AdminLoans from './pages/AdminLoans.jsx';
import EmployeeLoans from './pages/EmployeeLoans.jsx';
import AdminInvestmentDeclarations from './pages/AdminInvestmentDeclarations.jsx';
import EmployeeInvestmentDeclaration from './pages/EmployeeInvestmentDeclaration.jsx';
import AdminCompliance from './pages/AdminCompliance.jsx';
import AdminSurveys from './pages/AdminSurveys.jsx';
import EmployeeSurveys from './pages/EmployeeSurveys.jsx';
import AdminTravel from './pages/AdminTravel.jsx';
import EmployeeTravel from './pages/EmployeeTravel.jsx';
import AdminCourses from './pages/AdminCourses.jsx';
import EmployeeLearning from './pages/EmployeeLearning.jsx';
import AdminReviewCycles from './pages/AdminReviewCycles.jsx';
import EmployeeReviews from './pages/EmployeeReviews.jsx';
import AdminAnalytics from './pages/AdminAnalytics.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import { useAuthStore } from './store/authStore';

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
        <Route path="knowledge-base" element={<AdminKnowledgeBase />} />
        <Route path="holidays" element={<AdminHolidays />} />
        <Route path="events" element={<AdminEvents />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="exits" element={<AdminExit />} />
      </Route>

      <Route
        path="/employee"
        element={
          <ProtectedRoute roles={['Employee', 'HRManager', 'SuperAdmin']}>
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
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
