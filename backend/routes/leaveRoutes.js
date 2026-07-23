/**
 * Leave router — mounted at /api/leaves.
 * Employee leave balance/requests self-service plus HR/Admin approval
 * and leave-balance management.
 * All routes require authentication (router.use(protect)).
 */
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
// GET /me/balance — current user's leave balance; protected.
router.get('/me/balance', getMyBalance);
// GET /me/requests — current user's leave requests; protected.
router.get('/me/requests', listMyRequests);
// POST /me/requests — apply for leave; protected.
router.post('/me/requests', applyForLeave);
// PATCH /me/requests/:id/cancel — cancel own leave request; protected.
router.patch('/me/requests/:id/cancel', cancelMyRequest);

// HR/Admin — everything below requires the 'leave.manage' permission.
router.use(requirePermission('leave.manage'));

// GET /requests — list all leave requests; protected, requires 'leave.manage'.
router.get('/requests', listAllRequests);
// PATCH /requests/:id/approve — approve a leave request; protected, requires 'leave.manage'.
router.patch('/requests/:id/approve', approveRequest);
// PATCH /requests/:id/reject — reject a leave request; protected, requires 'leave.manage'.
router.patch('/requests/:id/reject', rejectRequest);
// GET /balances — list employee leave balances; protected, requires 'leave.manage'.
router.get('/balances', listBalances);
// PUT /balances/:employeeId/:year — set an employee's leave balance for a year; protected, requires 'leave.manage'.
router.put('/balances/:employeeId/:year', upsertBalance);

module.exports = router;
