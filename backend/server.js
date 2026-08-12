// /**
//  * HRMS backend entrypoint. Boots the Express app and, after the DB connects,
//  * starts the background workers and begins listening.
//  *
//  * Middleware pipeline (order matters):
//  *   1. CORS (exposes Content-Disposition for named file downloads)
//  *   2. express.json() body parser
//  *   3. requestContext — AsyncLocalStorage so the audit plugin can attribute
//  *      changes to req.user
//  *   ...all route groups...
//  *   last. notFound (404) then errorHandler (central error responder)
//  *
//  * Mounted route groups: everything under /api/* — health, auth, admin,
//  * employees, payroll, leave/approvals/manager, attendance/shifts/regularizations,
//  * documents, celebrations, exits, chat, complaints, change/password-reset
//  * requests, holidays/events/notifications/devices, departments/work-locations,
//  * dashboard, projects/tasks, recruitment, assets, performance/training,
//  * expenses, onboarding, announcements, rnr, guides, org masters/org/lifecycle,
//  * salary-structures/loans/cashbook/declarations/compliance, surveys, travel,
//  * courses (+ public), reviews, analytics, and audit.
//  *
//  * Startup (after connectDB): email, celebration, attendance, and exit workers;
//  * a one-off HR-profile backfill; then app.listen on PORT (default 5000).
//  * The workers own their own cron schedules internally.
//  */
// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const connectDB = require('./config/db');
// const { notFound, errorHandler } = require('./middleware/errorHandler');
// const { startWorker: startEmailWorker } = require('./services/emailWorker');
// const { startWorker: startCelebrationWorker } = require('./services/celebrationWorker');
// const { startWorker: startAttendanceWorker } = require('./services/attendanceWorker');
// const { startWorker: startExitWorker } = require('./services/exitWorker');
// const { backfillHrProfiles } = require('./services/ensureProfile');
// const { requestContext } = require('./middleware/requestContext');

// const app = express();

// // exposedHeaders lets the browser read Content-Disposition on cross-origin
// // downloads (attendance/payroll exports, payslips) so the file keeps its
// // server-provided name instead of a generic "download".
// app.use(cors({
//   origin: process.env.CORS_ORIGIN || '*',
//   credentials: true,
//   exposedHeaders: ['Content-Disposition'],
// }));
// app.use(express.json());
// // Carry the request (and, once authenticated, req.user) through async calls so
// // the audit plugin can attribute status changes to the acting user.
// app.use(requestContext);

// // Liveness probe. `status`/`service` are the original contract (the web client
// // probes this to decide between the local and deployed backend), and the rest
// // makes a deploy verifiable from outside: without it there is no way to tell
// // which commit Railway is actually running. Railway injects the git metadata;
// // locally those are simply absent.
// const BOOTED_AT = new Date();
// app.get('/api/health', (req, res) => {
//   res.json({
//     status: 'ok',
//     service: 'sequence-hrms-backend',
//     commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
//     branch: process.env.RAILWAY_GIT_BRANCH || null,
//     fileStore: 'gridfs',
//     startedAt: BOOTED_AT.toISOString(),
//     uptimeSeconds: Math.round(process.uptime()),
//   });
// });

// app.use('/api/auth', require('./routes/authRoutes'));
// app.use('/api/admin', require('./routes/adminRoutes'));
// app.use('/api/employees', require('./routes/employeeRoutes'));
// app.use('/api/payroll', require('./routes/payrollRoutes'));
// app.use('/api/leave', require('./routes/leaveRoutes'));
// app.use('/api/approvals', require('./routes/approvalRoutes'));
// app.use('/api/manager', require('./routes/managerRoutes'));
// app.use('/api/attendance', require('./routes/attendanceRoutes'));
// app.use('/api/documents', require('./routes/documentRoutes'));
// app.use('/api/celebrations', require('./routes/celebrationsRoutes'));
// app.use('/api/exits', require('./routes/exitRoutes'));
// app.use('/api/chat', require('./routes/chatRoutes'));
// app.use('/api/complaints', require('./routes/complaintRoutes'));
// app.use('/api/change-requests', require('./routes/changeRequestRoutes'));
// app.use('/api/password-reset-requests', require('./routes/passwordResetRoutes'));
// app.use('/api/holidays', require('./routes/holidayRoutes'));
// app.use('/api/events', require('./routes/eventRoutes'));
// app.use('/api/reminders', require('./routes/reminderRoutes'));
// app.use('/api/notifications', require('./routes/notificationRoutes'));
// app.use('/api/devices', require('./routes/deviceRoutes'));
// app.use('/api/departments', require('./routes/departmentRoutes'));
// app.use('/api/work-locations', require('./routes/workLocationRoutes'));
// app.use('/api/dashboard', require('./routes/dashboardRoutes'));
// app.use('/api/projects', require('./routes/projectRoutes'));
// app.use('/api/tasks', require('./routes/taskRoutes'));
// app.use('/api/recruitment', require('./routes/recruitmentRoutes'));
// app.use('/api/assets', require('./routes/assetRoutes'));
// app.use('/api/performance', require('./routes/performanceRoutes'));
// app.use('/api/training', require('./routes/trainingRoutes'));
// app.use('/api/expenses', require('./routes/expenseRoutes'));
// app.use('/api/onboarding', require('./routes/onboardingRoutes'));
// app.use('/api/announcements', require('./routes/announcementRoutes'));
// app.use('/api/rnr', require('./routes/rnrRoutes'));
// app.use('/api/guides', require('./routes/guideRoutes'));
// app.use('/api/org-masters', require('./routes/orgMasterRoutes'));
// app.use('/api/org', require('./routes/orgRoutes'));
// app.use('/api/lifecycle', require('./routes/lifecycleRoutes'));
// app.use('/api/shifts', require('./routes/shiftRoutes'));
// app.use('/api/regularizations', require('./routes/regularizationRoutes'));
// app.use('/api/salary-structures', require('./routes/salaryStructureRoutes'));
// app.use('/api/loans', require('./routes/loanRoutes'));
// app.use('/api/cashbook', require('./routes/cashbookRoutes'));
// app.use('/api/declarations', require('./routes/declarationRoutes'));
// app.use('/api/compliance', require('./routes/complianceRoutes'));
// app.use('/api/surveys', require('./routes/surveyRoutes'));
// app.use('/api/travel', require('./routes/travelRoutes'));
// app.use('/api/courses', require('./routes/courseRoutes'));
// app.use('/api/public/courses', require('./routes/publicCourseRoutes'));
// app.use('/api/reviews', require('./routes/reviewRoutes'));
// app.use('/api/analytics', require('./routes/analyticsRoutes'));
// app.use('/api/audit', require('./routes/auditRoutes'));
// app.use('/api/reports', require('./routes/reportRoutes'));

// app.use(notFound);
// app.use(errorHandler);

// const PORT = process.env.PORT || 5000;

// connectDB()
//   .then(() => {
//     startEmailWorker();
//     startCelebrationWorker();
//     startAttendanceWorker();
//     startExitWorker();
//     backfillHrProfiles().catch((err) => console.error('HR profile backfill error:', err.message));
//     app.listen(PORT, () => {
//       console.log(`HRMS API listening on port ${PORT}`);
//     });
//   })
//   .catch((err) => {
//     console.error('Failed to start server:', err.message);
//     process.exit(1);
//   });



/**
 * HRMS backend entrypoint. Boots the Express app and, after the DB connects,
 * starts the background workers and begins listening.
 *
 * Middleware pipeline (order matters):
 *
 * 1. CORS (exposes Content-Disposition for named file downloads)
 * 2. express.json() body parser
 * 3. requestContext — AsyncLocalStorage so the audit plugin can attribute
 *    changes to req.user
 * 4. Root + health routes
 * 5. ...all route groups...
 * 6. last. notFound (404) then errorHandler (central error responder)
 *
 * Mounted route groups: everything under /api/*
 *
 * Startup (after connectDB): email, celebration, attendance, push-reminder
 * and exit workers; a one-off HR-profile backfill; then app.listen on PORT (default 5000).
 * The workers own their own cron schedules internally.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const { notFound, errorHandler } = require('./middleware/errorHandler');

const { startWorker: startEmailWorker } = require('./services/emailWorker');
const { startWorker: startCelebrationWorker } = require('./services/celebrationWorker');
const { startWorker: startAttendanceWorker } = require('./services/attendanceWorker');
const { startWorker: startPushReminderWorker } = require('./services/pushReminderWorker');
const { startWorker: startExitWorker } = require('./services/exitWorker');

const { backfillHrProfiles } = require('./services/ensureProfile');
const { requestContext } = require('./middleware/requestContext');

const app = express();

/* ============================================================
   MIDDLEWARE
   ============================================================ */

// CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  })
);

// JSON body parser
app.use(express.json());

// Request context for audit logging
app.use(requestContext);

/* ============================================================
   SERVER INFO / HEALTH CHECK
   ============================================================ */

const BOOTED_AT = new Date();

/**
 * Root endpoint
 *
 * This prevents:
 * GET https://hrms-cfyq.onrender.com/
 * from returning "Not found - /"
 */
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'sequence-hrms-backend',
    message: 'HRMS API is running',
    environment: process.env.NODE_ENV || 'production',
  });
});

/**
 * Health check endpoint
 *
 * Used by Render and frontend/client health checks.
 */
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'sequence-hrms-backend',
    environment: process.env.NODE_ENV || 'production',
    fileStore: 'gridfs',
    startedAt: BOOTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/* ============================================================
   API ROUTES
   ============================================================ */

app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/employees', require('./routes/employeeRoutes'));
app.use('/api/payroll', require('./routes/payrollRoutes'));
app.use('/api/leave', require('./routes/leaveRoutes'));
app.use('/api/approvals', require('./routes/approvalRoutes'));
app.use('/api/manager', require('./routes/managerRoutes'));

app.use('/api/attendance', require('./routes/attendanceRoutes'));
app.use('/api/documents', require('./routes/documentRoutes'));
app.use('/api/celebrations', require('./routes/celebrationsRoutes'));
app.use('/api/exits', require('./routes/exitRoutes'));
app.use('/api/chat', require('./routes/chatRoutes'));
app.use('/api/complaints', require('./routes/complaintRoutes'));

app.use('/api/change-requests', require('./routes/changeRequestRoutes'));
app.use(
  '/api/password-reset-requests',
  require('./routes/passwordResetRoutes')
);

app.use('/api/holidays', require('./routes/holidayRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
app.use('/api/reminders', require('./routes/reminderRoutes'));
app.use('/api/notifications', require('./routes/notificationRoutes'));
app.use('/api/devices', require('./routes/deviceRoutes'));

app.use('/api/departments', require('./routes/departmentRoutes'));
app.use('/api/work-locations', require('./routes/workLocationRoutes'));

app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/projects', require('./routes/projectRoutes'));
app.use('/api/tasks', require('./routes/taskRoutes'));
app.use('/api/recruitment', require('./routes/recruitmentRoutes'));

app.use('/api/assets', require('./routes/assetRoutes'));
app.use('/api/performance', require('./routes/performanceRoutes'));
app.use('/api/training', require('./routes/trainingRoutes'));
app.use('/api/expenses', require('./routes/expenseRoutes'));
app.use('/api/onboarding', require('./routes/onboardingRoutes'));
app.use('/api/announcements', require('./routes/announcementRoutes'));

app.use('/api/rnr', require('./routes/rnrRoutes'));
app.use('/api/guides', require('./routes/guideRoutes'));

app.use('/api/org-masters', require('./routes/orgMasterRoutes'));
app.use('/api/org', require('./routes/orgRoutes'));
app.use('/api/lifecycle', require('./routes/lifecycleRoutes'));

app.use('/api/shifts', require('./routes/shiftRoutes'));
app.use('/api/regularizations', require('./routes/regularizationRoutes'));

app.use('/api/salary-structures', require('./routes/salaryStructureRoutes'));
app.use('/api/loans', require('./routes/loanRoutes'));
app.use('/api/cashbook', require('./routes/cashbookRoutes'));
app.use('/api/declarations', require('./routes/declarationRoutes'));
app.use('/api/compliance', require('./routes/complianceRoutes'));

app.use('/api/surveys', require('./routes/surveyRoutes'));
app.use('/api/travel', require('./routes/travelRoutes'));

app.use('/api/courses', require('./routes/courseRoutes'));
app.use('/api/public/courses', require('./routes/publicCourseRoutes'));

app.use('/api/reviews', require('./routes/reviewRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/audit', require('./routes/auditRoutes'));
app.use('/api/templates', require('./routes/templateRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/push-reminders', require('./routes/pushReminderRoutes'));

/* ============================================================
   ERROR HANDLING
   ============================================================ */

// 404 handler must come after all routes
app.use(notFound);

// Central error handler
app.use(errorHandler);

/* ============================================================
   SERVER STARTUP
   ============================================================ */

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    console.log('MongoDB connected successfully');

    // Start background workers
    startEmailWorker();
    startCelebrationWorker();
    startAttendanceWorker();
    startPushReminderWorker();
    startExitWorker();

    // One-time HR profile backfill
    backfillHrProfiles().catch((err) => {
      console.error('HR profile backfill error:', err.message);
    });

    // Start Express server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`HRMS API listening on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

