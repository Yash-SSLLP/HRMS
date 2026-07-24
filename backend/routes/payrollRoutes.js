/**
 * Payroll router — mounted at /api/payroll.
 * Public tokenised payslip download, employee payslip self-service, and
 * HR/Admin payslip CRUD, payroll runs, exports, and sharing/emailing.
 */
const express = require('express');
const {
  listMyPayslips,
  getMyPayslip,
  myAttendanceSummary,
  listPayslips,
  getPayslip,
  createPayslip,
  updatePayslip,
  approvePayslip,
  markPayslipPaid,
  deletePayslip,
  downloadPayslipPdf,
  downloadMyPayslipPdf,
  sharePayslip,
  markPayslipSent,
  emailPayslip,
  downloadPublicPayslip,
  exportPayrollSheet,
  previewPayrollRun,
  runPayroll,
  previewEmployeeRun,
  runEmployeePayroll,
  deriveSalaryForEditor,
  giveHike,
} = require('../controllers/payrollController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Public, no-login payslip download via shareable token (declared before the
// auth guard so it stays open).
// GET /public/:token — download a shared payslip; public (token-scoped).
router.get('/public/:token', downloadPublicPayslip);

router.use(protect);

// Employee self-service
// GET /me — current user's payslips; protected.
router.get('/me', listMyPayslips);
// GET /me/attendance-summary — own attendance summary for payroll; protected.
router.get('/me/attendance-summary', myAttendanceSummary);
// GET /me/:id/pdf — download own payslip PDF; protected.
router.get('/me/:id/pdf', downloadMyPayslipPdf);
// GET /me/:year/:month — own payslip for a month; protected.
router.get('/me/:year/:month', getMyPayslip);

// HR/Admin only — everything below requires the 'payroll.manage' permission.
router.use(requirePermission('payroll.manage'));

// GET / — list payslips; POST / — create one; protected, requires 'payroll.manage'.
router.route('/')
  .get(listPayslips)
  .post(createPayslip);

// GET /export-sheet — export the company payroll register (.xlsx); requires 'payroll.manage'.
router.get('/export-sheet', exportPayrollSheet);
// GET /run — preview a payroll run; POST /run — execute it; protected, requires 'payroll.manage'.
router.route('/run').get(previewPayrollRun).post(runPayroll);
// GET /run-employee — preview a single-employee run; POST — execute it; protected, requires 'payroll.manage'.
router.route('/run-employee').get(previewEmployeeRun).post(runEmployeePayroll);
// GET /derive-salary — earnings+deductions from structure×CTC for the payslip editor; requires 'payroll.manage'.
router.get('/derive-salary', deriveSalaryForEditor);
// POST /employees/:id/hike — apply a CTC hike/increment to an employee; requires 'payroll.manage'.
router.post('/employees/:id/hike', giveHike);

// GET /:id — fetch; PUT /:id — update; DELETE /:id — delete a payslip; protected, requires 'payroll.manage'.
router.route('/:id')
  .get(getPayslip)
  .put(updatePayslip)
  .delete(deletePayslip);

// GET /:id/pdf — download a payslip PDF; protected, requires 'payroll.manage'.
router.get('/:id/pdf', downloadPayslipPdf);
// PATCH /:id/approve — approve a payslip; protected, requires 'payroll.manage'.
router.patch('/:id/approve', approvePayslip);
// PATCH /:id/pay — mark a payslip paid; protected, requires 'payroll.manage'.
router.patch('/:id/pay', markPayslipPaid);
// POST /:id/share — generate a shareable payslip link; protected, requires 'payroll.manage'.
router.post('/:id/share', sharePayslip);
// POST /:id/mark-sent — mark a payslip as sent; protected, requires 'payroll.manage'.
router.post('/:id/mark-sent', markPayslipSent);
// POST /:id/email — email a payslip to the employee; protected, requires 'payroll.manage'.
router.post('/:id/email', emailPayslip);

module.exports = router;
