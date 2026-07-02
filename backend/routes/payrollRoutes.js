const express = require('express');
const {
  listMyPayslips,
  getMyPayslip,
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
  downloadPublicPayslip,
  exportPayroll,
} = require('../controllers/payrollController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// Public, no-login payslip download via shareable token (declared before the
// auth guard so it stays open).
router.get('/public/:token', downloadPublicPayslip);

router.use(protect);

// Employee self-service
router.get('/me', listMyPayslips);
router.get('/me/:id/pdf', downloadMyPayslipPdf);
router.get('/me/:year/:month', getMyPayslip);

// HR/Admin only
router.use(restrictTo('SuperAdmin', 'HRManager'));

router.route('/')
  .get(listPayslips)
  .post(createPayslip);

router.get('/export', exportPayroll);

router.route('/:id')
  .get(getPayslip)
  .put(updatePayslip)
  .delete(deletePayslip);

router.get('/:id/pdf', downloadPayslipPdf);
router.patch('/:id/approve', approvePayslip);
router.patch('/:id/pay', markPayslipPaid);
router.post('/:id/share', sharePayslip);
router.post('/:id/mark-sent', markPayslipSent);

module.exports = router;
