const express = require('express');
const {
  getMyBalance,
  listMyRequests,
  applyForLeave,
  cancelMyRequest,
  listAllRequests,
  approveRequest,
  rejectRequest,
  listBalances,
  upsertBalance,
} = require('../controllers/leaveController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self-service
router.get('/me/balance', getMyBalance);
router.get('/me/requests', listMyRequests);
router.post('/me/requests', applyForLeave);
router.patch('/me/requests/:id/cancel', cancelMyRequest);

// HR/Admin
router.use(requirePermission('leave.manage'));

router.get('/requests', listAllRequests);
router.patch('/requests/:id/approve', approveRequest);
router.patch('/requests/:id/reject', rejectRequest);
router.get('/balances', listBalances);
router.put('/balances/:employeeId/:year', upsertBalance);

module.exports = router;
