import { lazy, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useThemeStore } from './store/themeStore';
import { adminNav, employeeNav, ldNav } from './config/nav';
// Public auth/entry pages stay eager (they render outside the app shell).
import Login from './pages/Login.jsx';
import ExitFeedback from './pages/ExitFeedback.jsx';
import ApplyForm from './pages/ApplyForm.jsx';
import DocumentSubmitForm from './pages/DocumentSubmitForm.jsx';
import EmployeeDocSubmit from './pages/EmployeeDocSubmit.jsx';
import LetterDownload from './pages/LetterDownload.jsx';
import PublicCoursePage from './pages/PublicCoursePage.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import { useAuthStore } from './store/authStore';

// In-app pages are lazy-loaded — the Layout shows a skeleton (Suspense) while
// each page's chunk loads, and this code-splits the bundle.
const AdminDashboard = lazy(() => import('./pages/AdminDashboard.jsx'));
const AdminEmployees = lazy(() => import('./pages/AdminEmployees.jsx'));
const AdminEmployeeDetail = lazy(() => import('./pages/AdminEmployeeDetail.jsx'));
const AdminPayroll = lazy(() => import('./pages/AdminPayroll.jsx'));
const AdminPayrollRun = lazy(() => import('./pages/AdminPayrollRun.jsx'));
const AdminLeave = lazy(() => import('./pages/AdminLeave.jsx'));
const AdminLeaveApprovals = lazy(() => import('./pages/AdminLeaveApprovals.jsx'));
const AdminAttendance = lazy(() => import('./pages/AdminAttendance.jsx'));
const AdminAttendanceReport = lazy(() => import('./pages/AdminAttendanceReport.jsx'));
const AdminAttendanceMonth = lazy(() => import('./pages/AdminAttendanceMonth.jsx'));
const AdminPresence = lazy(() => import('./pages/AdminPresence.jsx'));
const EmployeeTeam = lazy(() => import('./pages/EmployeeTeam.jsx'));
const EmployeeApprovals = lazy(() => import('./pages/EmployeeApprovals.jsx'));
const EmployeeInterviews = lazy(() => import('./pages/EmployeeInterviews.jsx'));
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
const AdminPasswordResets = lazy(() => import('./pages/AdminPasswordResets.jsx'));
const Calendar = lazy(() => import('./pages/Calendar.jsx'));
const AdminHolidays = lazy(() => import('./pages/AdminHolidays.jsx'));
const AdminEvents = lazy(() => import('./pages/AdminEvents.jsx'));
const AdminDepartments = lazy(() => import('./pages/AdminDepartments.jsx'));
const AdminWorkLocations = lazy(() => import('./pages/AdminWorkLocations.jsx'));
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
const AdminHiringOnboarding = lazy(() => import('./pages/AdminHiringOnboarding.jsx'));
const AdminNewJoinees = lazy(() => import('./pages/AdminNewJoinees.jsx'));
const AdminAuditLog = lazy(() => import('./pages/AdminAuditLog.jsx'));
const AdminChatExport = lazy(() => import('./pages/AdminChatExport.jsx'));
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
const CoursePlayerPage = lazy(() => import('./pages/CoursePlayerPage.jsx'));
const AdminReviewCycles = lazy(() => import('./pages/AdminReviewCycles.jsx'));
const EmployeeReviews = lazy(() => import('./pages/EmployeeReviews.jsx'));
const AdminAnalytics = lazy(() => import('./pages/AdminAnalytics.jsx'));

function RootRedirect() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  // Employees and Managers live in the employee portal; everyone else (admins,
  // the read-only CEO/MD executives, and the LMS-only HR L&D admin) goes to the
  // admin portal.
  const employeePortal = ['Employee', 'Manager'].includes(user.role);
  return <Navigate to={employeePortal ? '/employee' : '/admin'} replace />;
}

// Landing route for the admin portal. Most admins land on the dashboard, but the
// HR L&D (LDManager) admin can't reach the dashboard API, so send them straight
// to their only page — Courses.
function AdminHome() {
  const role = useAuthStore((s) => s.user?.role);
  return <Navigate to={role === 'LDManager' ? 'courses' : 'dashboard'} replace />;
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

      {/* Public — candidate document submission (tokenised link) */}
      <Route path="/submit-documents/:token" element={<DocumentSubmitForm />} />
      <Route path="/employee-docs/:token" element={<EmployeeDocSubmit />} />

      {/* Public — candidate offer/appointment letter download (tokenised link) */}
      <Route path="/letter/:token" element={<LetterDownload />} />

      {/* Public — no-login course viewer (shareable link) */}
      <Route path="/learn/:token" element={<PublicCoursePage />} />

      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={['SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager']}>
            <Layout navItems={role === 'LDManager' ? ldNav : adminNav} sectionTitle="Admin" />
          </ProtectedRoute>
        }
      >
        <Route index element={<AdminHome />} />
        <Route path="dashboard" element={<AdminOverview />} />
        <Route path="users" element={<AdminDashboard />} />
        <Route path="employees" element={<AdminEmployees />} />
        <Route path="employees/:id" element={<AdminEmployeeDetail />} />
        <Route path="departments" element={<AdminDepartments />} />
        <Route path="work-locations" element={<AdminWorkLocations />} />
        <Route path="org-masters" element={<AdminOrgMasters />} />
        <Route path="org-chart" element={<AdminOrgChart />} />
        <Route path="onboarding" element={<AdminOnboarding />} />
        <Route path="confirmations" element={<AdminConfirmations />} />
        <Route path="attendance" element={<AdminAttendance />} />
        <Route path="presence" element={<AdminPresence />} />
        <Route path="attendance-report" element={<AdminAttendanceReport />} />
        <Route path="attendance-month" element={<AdminAttendanceMonth />} />
        <Route path="roster" element={<AdminRoster />} />
        <Route path="regularizations" element={<AdminRegularizations />} />
        <Route path="payroll" element={<AdminPayroll />} />
        <Route path="payroll-run" element={<AdminPayrollRun />} />
        <Route path="salary-structures" element={<AdminSalaryStructures />} />
        <Route path="loans" element={<AdminLoans />} />
        <Route path="declarations" element={<AdminInvestmentDeclarations />} />
        <Route path="compliance" element={<AdminCompliance />} />
        <Route path="leave" element={<AdminLeave />} />
        <Route path="leave-approvals" element={<AdminLeaveApprovals />} />
        <Route path="compoff" element={<AdminCompOff />} />
        <Route path="expenses" element={<AdminExpenses />} />
        <Route path="travel" element={<AdminTravel />} />
        <Route path="documents" element={<AdminDocuments />} />
        <Route path="projects" element={<AdminProjects />} />
        <Route path="tasks" element={<AdminTasks />} />
        <Route path="recruitment" element={<AdminRecruitment />} />
        <Route path="hiring-onboarding" element={<AdminHiringOnboarding />} />
        <Route path="new-joinees" element={<AdminNewJoinees />} />
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
        <Route path="password-resets" element={<AdminPasswordResets />} />
        <Route path="audit-log" element={<AdminAuditLog />} />
        <Route path="chat-export" element={<AdminChatExport />} />
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
          <ProtectedRoute roles={['Employee', 'HRManager', 'Manager']}>
            <Layout navItems={employeeNav} sectionTitle="My Portal" />
          </ProtectedRoute>
        }
      >
        <Route index element={<EmployeeDashboard />} />
        <Route path="approvals" element={<EmployeeApprovals />} />
        <Route path="team" element={<EmployeeTeam />} />
        <Route path="interviews" element={<EmployeeInterviews />} />
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
        <Route path="learning/:courseId" element={<CoursePlayerPage />} />
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

// This is Yash Kumar Roy, a AI Engineer and a tech enthusiast. I have a strong passion for building web applications and exploring new technologies.