require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { startWorker: startEmailWorker } = require('./services/emailWorker');
const { startWorker: startCelebrationWorker } = require('./services/celebrationWorker');
const { startWorker: startAttendanceWorker } = require('./services/attendanceWorker');
const { backfillHrProfiles } = require('./services/ensureProfile');
const { requestContext } = require('./middleware/requestContext');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());
// Carry the request (and, once authenticated, req.user) through async calls so
// the audit plugin can attribute status changes to the acting user.
app.use(requestContext);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'indian-hrms-backend' });
});

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
app.use('/api/password-reset-requests', require('./routes/passwordResetRoutes'));
app.use('/api/holidays', require('./routes/holidayRoutes'));
app.use('/api/events', require('./routes/eventRoutes'));
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
app.use('/api/kb', require('./routes/kbRoutes'));
app.use('/api/recognition', require('./routes/recognitionRoutes'));
app.use('/api/org-masters', require('./routes/orgMasterRoutes'));
app.use('/api/org', require('./routes/orgRoutes'));
app.use('/api/lifecycle', require('./routes/lifecycleRoutes'));
app.use('/api/shifts', require('./routes/shiftRoutes'));
app.use('/api/regularizations', require('./routes/regularizationRoutes'));
app.use('/api/compoff', require('./routes/compOffRoutes'));
app.use('/api/salary-structures', require('./routes/salaryStructureRoutes'));
app.use('/api/loans', require('./routes/loanRoutes'));
app.use('/api/declarations', require('./routes/declarationRoutes'));
app.use('/api/compliance', require('./routes/complianceRoutes'));
app.use('/api/surveys', require('./routes/surveyRoutes'));
app.use('/api/travel', require('./routes/travelRoutes'));
app.use('/api/courses', require('./routes/courseRoutes'));
app.use('/api/public/courses', require('./routes/publicCourseRoutes'));
app.use('/api/reviews', require('./routes/reviewRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/audit', require('./routes/auditRoutes'));

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    startEmailWorker();
    startCelebrationWorker();
    startAttendanceWorker();
    backfillHrProfiles().catch((err) => console.error('HR profile backfill error:', err.message));
    app.listen(PORT, () => {
      console.log(`HRMS API listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
