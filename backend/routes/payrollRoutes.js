/**
 * Payroll router — mounted at /api/payroll.
 * Public tokenised payslip download, employee payslip self-service, the
 * CEO/MD/Super Admin sanction of payslips their own subject prepared, and
 * HR/Admin payslip CRUD, payroll runs, exports, and sharing/emailing.
 */
const express = require('express');
const {
  listMyPayslips,
  requestMyPayslip,
  requestPayslipForMonth,
  withdrawMyPayslipRequest,
  declinePayslipRequest,
  requestMyPayslipChange,
  approvePayslipRelease,
  finalisePayslipRelease,
  listSelfApprovals,
  approveSelfPayslip,
  rejectSelfPayslip,
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
  salarySetupStatus,
} = require('../controllers/payrollController');
const {
  protect, restrictTo, requirePermission, requireSelfPayslipApprover,
} = require('../middleware/authMiddleware');

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
// GET /me/:id/pdf — download own payslip PDF; protected, only once HR has finalised it.
router.get('/me/:id/pdf', downloadMyPayslipPdf);
// POST /me/:id/request — ask HR to release this payslip; protected.
router.post('/me/:id/request', requestMyPayslip);
// POST /me/:year/:month/request — ask HR for a payslip for a GIVEN MONTH,
// including a month payroll has never been run for. This is the route that
// makes "any month" possible: the id-addressed route above can only reach a
// payslip that already exists AND is already Approved or Paid.
//
// Declared ABOVE `GET /me/:year/:month` and above `router.route('/:id')`, and
// deliberately four segments + POST so neither can shadow it. It must also NOT
// end in '/preview' — VIEW_ONLY_POST_ALLOW in authMiddleware matches that
// suffix unanchored, which would let the view-only God account write here.
router.post('/me/:year/:month/request', requestPayslipForMonth);
// DELETE /me/:year/:month/request — take back a request HR has not started on.
router.delete('/me/:year/:month/request', withdrawMyPayslipRequest);
// POST /me/:id/change-request — ask HR to correct a released payslip; protected.
router.post('/me/:id/change-request', requestMyPayslipChange);
// GET /me/:year/:month — own payslip for a month; protected.
router.get('/me/:year/:month', getMyPayslip);

// ===== Self-prepared payslips: the executive sanction =====
// An HR Manager may write their own payslip, and it is frozen until a CEO, MD or
// Super Admin sanctions it (see models/Payroll.js -> selfApproval).
//
// Declared ABOVE the 'payroll.manage' gate deliberately, for two reasons:
//   1. That gate refuses a read-only CEO/MD on any non-GET before a handler is
//      ever reached, and these routes are addressed TO those accounts.
//   2. It is the wrong key anyway — 'payroll.manage' is held by the very HR
//      Manager whose payslip is being judged.
// requireSelfPayslipApprover is the gate instead: SuperAdmin, CEO or MD.
// GET /self-approvals — payslips awaiting (or already given) a sanction.
router.get('/self-approvals', requireSelfPayslipApprover, listSelfApprovals);
// PATCH /:id/self-approval/approve|reject — sanction or refuse one.
router.patch('/:id/self-approval/approve', requireSelfPayslipApprover, approveSelfPayslip);
router.patch('/:id/self-approval/reject', requireSelfPayslipApprover, rejectSelfPayslip);

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
// GET /salary-setup-status — active employees missing a salary structure and/or
// CTC; requires 'payroll.manage'. Declared before '/:id' so it isn't read as an id.
router.get('/salary-setup-status', salarySetupStatus);

// GET /:id — fetch; PUT /:id — update; DELETE /:id — delete a payslip; protected, requires 'payroll.manage'.
router.route('/:id')
  .get(getPayslip)
  .put(updatePayslip)
  .delete(deletePayslip);

// GET /:id/pdf — download a payslip PDF; protected, requires 'payroll.manage'.
router.get('/:id/pdf', downloadPayslipPdf);
// PATCH /:id/approve — approve a payslip; protected, requires 'payroll.manage'.
router.patch('/:id/approve', approvePayslip);
// PATCH /:id/release/approve — approve the employee's request for their payslip;
// PATCH /:id/release/finalise — release it to them; both require 'payroll.manage'.
router.patch('/:id/release/approve', approvePayslipRelease);
router.patch('/:id/release/finalise', finalisePayslipRelease);
// POST /:id/request/decline — turn down a request for a month payroll has not
// been run for (shell only; the reason is required, audited and sent to the
// employee). Three segments + POST, so '/:id' cannot shadow it.
router.post('/:id/request/decline', declinePayslipRequest);
// PATCH /:id/pay — mark a payslip paid; protected, requires 'payroll.manage'.
router.patch('/:id/pay', markPayslipPaid);
// POST /:id/share — generate a shareable payslip link; protected, requires 'payroll.manage'.
router.post('/:id/share', sharePayslip);
// POST /:id/mark-sent — mark a payslip as sent; protected, requires 'payroll.manage'.
router.post('/:id/mark-sent', markPayslipSent);
// POST /:id/email — email a payslip to the employee; protected, requires 'payroll.manage'.
router.post('/:id/email', emailPayslip);

module.exports = router;
