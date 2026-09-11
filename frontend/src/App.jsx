// Root router + app shell. Declares every route: the login screen eagerly, the
// tokenised outsider links lazily, and two guarded
// portal trees — /admin and /employee — each wrapped in <ProtectedRoute> (role
// gate) + <Layout> (sidebar shell), with all in-app pages lazy-loaded for
// code-splitting. Also applies the dark-mode class and per-role accent to <html>.
import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useThemeStore } from './store/themeStore';
import { adminNav, employeeNav, ldNav, accountsNav } from './config/nav';
// Login stays eager: it is the first paint for every signed-out visitor, and
// the one screen where a chunk round-trip would be felt.
import Login from './pages/Login.jsx';
import PageSkeleton from './components/PageSkeleton.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Layout from './components/Layout.jsx';
import GlobalModalEscape from './components/GlobalModalEscape.jsx';
import { useAuthStore } from './store/authStore';

// The tokenised outsider pages (an ex-employee's exit form, a candidate's
// application, a document upload link, a letter download, a public course) are
// lazy too. Each is reached by pasting one emailed URL, at most once, by
// somebody who has no session — while EVERY signed-in employee was paying to
// download all five on every first load because they sat in the eager chunk.
// One extra request on a page nobody navigates to twice is the right trade.
const ExitFeedback = lazy(() => import('./pages/ExitFeedback.jsx'));
const ApplyForm = lazy(() => import('./pages/ApplyForm.jsx'));
const DocumentSubmitForm = lazy(() => import('./pages/DocumentSubmitForm.jsx'));
const EmployeeDocSubmit = lazy(() => import('./pages/EmployeeDocSubmit.jsx'));
const LetterDownload = lazy(() => import('./pages/LetterDownload.jsx'));
const PublicCoursePage = lazy(() => import('./pages/PublicCoursePage.jsx'));
const PublicBill = lazy(() => import('./pages/PublicBill.jsx'));

// In-app pages are lazy-loaded — the Layout shows a skeleton (Suspense) while
// each page's chunk loads, and this code-splits the bundle.
const AdminDashboard = lazy(() => import('./pages/AdminDashboard.jsx'));
const AdminEmployees = lazy(() => import('./pages/AdminEmployees.jsx'));
const AdminEmployeeDetail = lazy(() => import('./pages/AdminEmployeeDetail.jsx'));
const AdminPayroll = lazy(() => import('./pages/AdminPayroll.jsx'));
const AdminPayrollRun = lazy(() => import('./pages/AdminPayrollRun.jsx'));
const AdminPayslipRequests = lazy(() => import('./pages/AdminPayslipRequests.jsx'));
const AdminLeave = lazy(() => import('./pages/AdminLeave.jsx'));
const AdminLeaveApprovals = lazy(() => import('./pages/AdminLeaveApprovals.jsx'));
const AdminAttendance = lazy(() => import('./pages/AdminAttendance.jsx'));
const AdminAttendanceReport = lazy(() => import('./pages/AdminAttendanceReport.jsx'));
const AdminAttendanceMonth = lazy(() => import('./pages/AdminAttendanceMonth.jsx'));
const AdminPunchMap = lazy(() => import('./pages/AdminPunchMap.jsx'));
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
const AdminCompanies = lazy(() => import('./pages/AdminCompanies.jsx'));
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
const AdminSessions = lazy(() => import('./pages/AdminSessions.jsx'));
const AdminAccountSecurity = lazy(() => import('./pages/AdminAccountSecurity.jsx'));
const ChangePassword = lazy(() => import('./pages/ChangePassword.jsx'));
const AdminAppVersions = lazy(() => import('./pages/AdminAppVersions.jsx'));
const AdminAppRelease = lazy(() => import('./pages/AdminAppRelease.jsx'));
const AdminTemplates = lazy(() => import('./pages/AdminTemplates.jsx'));
const AdminChatExport = lazy(() => import('./pages/AdminChatExport.jsx'));
const EmployeeOnboarding = lazy(() => import('./pages/EmployeeOnboarding.jsx'));
const AdminAnnouncements = lazy(() => import('./pages/AdminAnnouncements.jsx'));
const EmployeeAnnouncements = lazy(() => import('./pages/EmployeeAnnouncements.jsx'));
const AdminRnr = lazy(() => import('./pages/AdminRnr.jsx'));
const HowToUse = lazy(() => import('./pages/HowToUse.jsx'));
const MobileApp = lazy(() => import('./pages/MobileApp.jsx'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy.jsx'));
const AdminOrgMasters = lazy(() => import('./pages/AdminOrgMasters.jsx'));
const AdminOrgChart = lazy(() => import('./pages/AdminOrgChart.jsx'));
const AdminConfirmations = lazy(() => import('./pages/AdminConfirmations.jsx'));
const AdminRoster = lazy(() => import('./pages/AdminRoster.jsx'));
const EmployeeShifts = lazy(() => import('./pages/EmployeeShifts.jsx'));
const AdminRegularizations = lazy(() => import('./pages/AdminRegularizations.jsx'));
const EmployeeRegularizations = lazy(() => import('./pages/EmployeeRegularizations.jsx'));
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
const AdminCashbook = lazy(() => import('./pages/AdminCashbook.jsx'));
const EmployeeCashbook = lazy(() => import('./pages/EmployeeCashbook.jsx'));
const AdminKhata = lazy(() => import('./pages/AdminKhata.jsx'));
const AdminBoysIncentive = lazy(() => import('./pages/AdminBoysIncentive.jsx'));
const AdminIncentivePoints = lazy(() => import('./pages/AdminIncentivePoints.jsx'));
const AdminIncentiveDashboard = lazy(() => import('./pages/AdminIncentiveDashboard.jsx'));
const AdminIncentiveLeaderboard = lazy(() => import('./pages/AdminIncentiveLeaderboard.jsx'));
const EmployeeIncentive = lazy(() => import('./pages/EmployeeIncentive.jsx'));
const EmployeeKhata = lazy(() => import('./pages/EmployeeKhata.jsx'));
const AdminPermissions = lazy(() => import('./pages/AdminPermissions.jsx'));
const AdminPushNotifications = lazy(() => import('./pages/AdminPushNotifications.jsx'));

/** Index route ("/"): send unauthenticated users to login, otherwise route each
 *  role to its home portal (employee vs admin). */
function RootRedirect() {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Navigate to="/login" replace />;
  // Employees and Managers live in the employee portal; everyone else (admins,
  // the read-only CEO/MD executives, the view-only God account, and the
  // LMS-only HR L&D admin) goes to the admin portal.
  const employeePortal = ['Employee', 'Manager'].includes(user.role);
  return <Navigate to={employeePortal ? '/employee' : '/admin'} replace />;
}

// Landing route for the admin portal. Most admins land on the dashboard, but the
// HR L&D (LDManager) admin can't reach the dashboard API, so send them straight
// to their only page — Courses.
function AdminHome() {
  const role = useAuthStore((s) => s.user?.role);
  if (role === 'LDManager') return <Navigate to="courses" replace />;
  if (role === 'AccountsManager') return <Navigate to="cashbook" replace />;
  // A Manager's admin portal is their team's approvals; the dashboard API is
  // gated above them, so landing there showed a raw 403 as the first thing they
  // saw after signing in.
  if (role === 'Manager') return <Navigate to="approvals" replace />;
  return <Navigate to="dashboard" replace />;
}

/** Root component: applies theme/role attributes to <html> and declares the
 *  full route table (public pages + guarded /admin and /employee portals). */
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
    <>
      {/* App-wide: Esc closes the top-most open modal */}
      <GlobalModalEscape />
      {/* The portal pages have Layout's own <Suspense> around the <Outlet>;
          the public routes are rendered outside that shell, so now that they
          are lazy they need a boundary of their own out here. */}
      <Suspense fallback={<PageSkeleton />}>
      <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<Login />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />

      {/* Forced password change after an admin reset. Inside ProtectedRoute (it
          needs the session to call PATCH /me/credentials) but OUTSIDE both portal
          trees, because the guard redirects every portal route here while
          user.mustChangePassword is set. */}
      <Route
        path="/change-password"
        element={<ProtectedRoute><ChangePassword /></ProtectedRoute>}
      />

      {/* Public — ex-employees access via tokenised link in email */}
      <Route path="/exit-feedback/:token" element={<ExitFeedback />} />

      {/* Public — job application form (shareable link) */}
      <Route path="/apply/:jobId" element={<ApplyForm />} />

      {/* Public — candidate document submission (tokenised link) */}
      <Route path="/submit-documents/:token" element={<DocumentSubmitForm />} />
      <Route path="/employee-docs/:token" element={<EmployeeDocSubmit />} />

      {/* Public — candidate offer/appointment letter download (tokenised link) */}
      <Route path="/letter/:token" element={<LetterDownload />} />

      {/* Public — the Android APK. Both endpoints behind this page are public
          (appReleaseRoutes), so a new joiner can install the app before their
          first sign-in and the link can go in a welcome email. */}
      <Route path="/get-app" element={<MobileApp standalone />} />

      {/* Public — no-login course viewer (shareable link) */}
      <Route path="/learn/:token" element={<PublicCoursePage />} />

      {/* Public — the full-size bill behind a thumbnail in a cashbook statement
          PDF. Signature-gated rather than login-gated: a PDF viewer opens a link
          in a plain tab with nowhere to put a bearer header. See PublicBill. */}
      <Route path="/bill/:id/:sig" element={<PublicBill />} />

      {/* Admin portal — role-gated to admin/exec roles; sidebar nav swaps to the
          single-page nav for the LMS-only and cashbook-only admins. */}
      <Route
        path="/admin"
        element={
          // Manager is listed, but `admin` makes the guard also require at least
          // one granted capability — the role alone opens nothing.
          <ProtectedRoute admin roles={['SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager', 'AccountsManager', 'God', 'Manager']}>
            <Layout navItems={role === 'LDManager' ? ldNav : role === 'AccountsManager' ? accountsNav : adminNav} sectionTitle="Admin" />
          </ProtectedRoute>
        }
      >
        <Route index element={<AdminHome />} />
        <Route path="dashboard" element={<AdminOverview />} />
        <Route path="users" element={<AdminDashboard />} />
        <Route path="permissions" element={<AdminPermissions />} />
        <Route path="push-notifications" element={<AdminPushNotifications />} />
        <Route path="employees" element={<AdminEmployees />} />
        <Route path="employees/:id" element={<AdminEmployeeDetail />} />
        <Route path="departments" element={<AdminDepartments />} />
        <Route path="work-locations" element={<AdminWorkLocations />} />
        <Route path="companies" element={<AdminCompanies />} />
        <Route path="org-masters" element={<AdminOrgMasters />} />
        <Route path="org-chart" element={<AdminOrgChart />} />
        <Route path="onboarding" element={<AdminOnboarding />} />
        <Route path="confirmations" element={<AdminConfirmations />} />
        <Route path="attendance" element={<AdminAttendance />} />
        <Route path="presence" element={<AdminPresence />} />
        <Route path="attendance-report" element={<AdminAttendanceReport />} />
        <Route path="attendance-month" element={<AdminAttendanceMonth />} />
        <Route path="punch-map" element={<AdminPunchMap />} />
        <Route path="roster" element={<AdminRoster />} />
        <Route path="regularizations" element={<AdminRegularizations />} />
        <Route path="payroll" element={<AdminPayroll />} />
        <Route path="payroll-run" element={<AdminPayrollRun />} />
        <Route path="payslip-requests" element={<AdminPayslipRequests />} />
        <Route path="salary-structures" element={<AdminSalaryStructures />} />
        <Route path="loans" element={<AdminLoans />} />
        <Route path="cashbook" element={<AdminCashbook />} />
        <Route path="khata" element={<AdminKhata />} />
        {/* CEO/MD self-service khatabook inside the admin portal (they have no employee portal). */}
        <Route path="my-khata" element={<EmployeeKhata />} />
        <Route path="boys-incentive" element={<AdminBoysIncentive />} />
        <Route path="incentive-points" element={<AdminIncentivePoints />} />
        <Route path="incentive-dashboard" element={<AdminIncentiveDashboard />} />
        {/* SuperAdmin only — the page says so and both endpoints behind it are
            restrictTo('SuperAdmin'). */}
        <Route path="incentive-leaderboard" element={<AdminIncentiveLeaderboard />} />
        <Route path="declarations" element={<AdminInvestmentDeclarations />} />
        <Route path="compliance" element={<AdminCompliance />} />
        <Route path="leave" element={<AdminLeave />} />
        <Route path="approvals" element={<AdminLeaveApprovals />} />
        {/* Back-compat: the page was renamed from "Leave Approvals" to the unified "Approvals". */}
        <Route path="leave-approvals" element={<AdminLeaveApprovals />} />
        <Route path="expenses" element={<AdminExpenses />} />
        <Route path="travel" element={<AdminTravel />} />
        <Route path="documents" element={<AdminDocuments />} />
        <Route path="projects" element={<AdminProjects />} />
        <Route path="tasks" element={<AdminTasks />} />
        <Route path="recruitment" element={<AdminRecruitment />} />
        {/* CEO/MD take interview rounds too, and have no employee portal to
            record them from — same page as /employee/interviews, which
            authorises on identity rather than on a role. */}
        <Route path="my-interviews" element={<EmployeeInterviews />} />
        <Route path="hiring-onboarding" element={<AdminHiringOnboarding />} />
        <Route path="new-joinees" element={<AdminNewJoinees />} />
        <Route path="assets" element={<AdminAssets />} />
        <Route path="performance" element={<AdminPerformance />} />
        <Route path="review-cycles" element={<AdminReviewCycles />} />
        <Route path="training" element={<AdminTraining />} />
        <Route path="courses" element={<AdminCourses />} />
        <Route path="analytics" element={<AdminAnalytics />} />
        <Route path="rnr" element={<AdminRnr />} />
        <Route path="how-to-use" element={<HowToUse />} />
        <Route path="mobile-app" element={<MobileApp />} />
        <Route path="announcements" element={<AdminAnnouncements />} />
        <Route path="surveys" element={<AdminSurveys />} />
        <Route path="complaints" element={<AdminComplaints />} />
        <Route path="change-requests" element={<AdminChangeRequests />} />
        <Route path="password-resets" element={<AdminPasswordResets />} />
        <Route path="audit-log" element={<AdminAuditLog />} />
        <Route path="sessions" element={<AdminSessions />} />
        <Route path="account-security" element={<AdminAccountSecurity />} />
        <Route path="app-versions" element={<AdminAppVersions />} />
        <Route path="app-release" element={<AdminAppRelease />} />
        <Route path="templates" element={<AdminTemplates />} />
        <Route path="chat-export" element={<AdminChatExport />} />
        <Route path="account" element={<EmployeeAccount />} />
        <Route path="holidays" element={<AdminHolidays />} />
        <Route path="events" element={<AdminEvents />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="exits" element={<AdminExit />} />
      </Route>

      {/* Employee (self-service) portal — Employees, Managers, and dual-role
          HRManagers who also use their own "My Portal". */}
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
        <Route path="expenses" element={<EmployeeExpenses />} />
        {/* Review queue for holders of the standalone Expenses grant who have no
            admin portal — the same page /admin/expenses serves, mounted here.
            The backend's expenses.manage gate is the real check. */}
        <Route path="expenses-manage" element={<AdminExpenses />} />
        <Route path="cashbook" element={<EmployeeCashbook />} />
        <Route path="cashbook-manage" element={<AdminCashbook />} />
        <Route path="khata" element={<EmployeeKhata />} />
        {/* The khata admin surface for standalone-grant holders who have no admin portal. */}
        <Route path="khata-manage" element={<AdminKhata />} />
        {/* Same for the incentive module — the supervisor who records the day's
            rolling team is an ordinary employee with the standalone grant.
            The backend's incentive.manage gate is the real check. */}
        <Route path="boys-incentive" element={<AdminBoysIncentive />} />
        <Route path="incentive-points" element={<AdminIncentivePoints />} />
        <Route path="incentive-dashboard" element={<AdminIncentiveDashboard />} />
        {/* My own points — ungated, unlike the three above it: earning points is
            not a capability. */}
        <Route path="my-incentive" element={<EmployeeIncentive />} />
        <Route path="travel" element={<EmployeeTravel />} />
        <Route path="documents" element={<EmployeeDocuments />} />
        <Route path="tasks" element={<EmployeeTasks />} />
        <Route path="assets" element={<EmployeeAssets />} />
        {/* Asset register for holders of the standalone Assets grant who have
            no admin portal — the same page /admin/assets serves, mounted here.
            The backend's assets.manage gate is the real check. */}
        <Route path="assets-manage" element={<AdminAssets />} />
        {/* Loan approvals for a standalone `loansAccess` holder — an accounts
            clerk with no admin portal. Same page HR uses at /admin/loans. */}
        <Route path="loans-manage" element={<AdminLoans />} />
        <Route path="goals" element={<EmployeeGoals />} />
        <Route path="reviews" element={<EmployeeReviews />} />
        <Route path="learning" element={<EmployeeLearning />} />
        <Route path="learning/:courseId" element={<CoursePlayerPage />} />
        <Route path="how-to-use" element={<HowToUse />} />
        <Route path="mobile-app" element={<MobileApp />} />
        <Route path="announcements" element={<EmployeeAnnouncements />} />
        <Route path="surveys" element={<EmployeeSurveys />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="complaints" element={<EmployeeComplaints />} />
        <Route path="exit" element={<EmployeeExit />} />
        <Route path="profile" element={<EmployeeProfile />} />
        <Route path="account" element={<EmployeeAccount />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </>
  );
}