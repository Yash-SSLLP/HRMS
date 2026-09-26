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
  whoIsOnLeave,
  applyForLeave,
  previewLeave,
  cancelMyRequest,
  setDoubleCut,
  reviewEmergencyLeave,
  amendLeaveRequest,
  listAllRequests,
  approveRequest,
  rejectRequest,
  listBalances,
  upsertBalance,
  markLeaveForEmployee,
} = require('../controllers/leaveController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self-service
// GET /me/balance — current user's leave balance; protected.
router.get('/me/balance', getMyBalance);
// GET /me/requests — current user's leave requests; protected.
router.get('/me/requests', listMyRequests);
// GET /me/leave-preview — preview paid-vs-LOP split for a would-be request; protected.
router.get('/me/leave-preview', previewLeave);
// POST /me/requests — apply for leave; protected.
router.post('/me/requests', applyForLeave);
// PATCH /me/requests/:id/cancel — cancel own leave request; protected.
router.patch('/me/requests/:id/cancel', cancelMyRequest);
// GET /on-leave?date=YYYY-MM-DD — who is on leave that day (the employee
// dashboard's "On leave" card). Any signed-in user, walled to their own company;
// names and full/half day only — never the leave type or the reason.
router.get('/on-leave', whoIsOnLeave);

// PATCH /emergency/:id/double-cut — charge (or un-charge) a flagged emergency
// leave at double pay. Sits ABOVE the leave.manage gate on purpose: the handler
// authorises HR *or* a manager on that employee's reporting ladder itself.
router.patch('/emergency/:id/double-cut', setDoubleCut);
// PATCH /emergency/:id/review — confirm that an emergency leave stands, or
// reject it (which un-stamps the calendar and turns the days back into absence).
// Sits above the leave.manage gate for the SAME reason as the double cut, and is
// authorised by the same rule: the handler asks assertLeaveReviewer, which
// admits managers on the ladder, HR, and the CEO/MD who were told about it.
// Emergency leave is granted on filing and asks nobody — this is the only place
// anyone gets to disagree with it.
router.patch('/emergency/:id/review', reviewEmergencyLeave);

// PATCH /requests/:id/amend — change a leave request's type or dates on the
// employee's behalf. Above the leave.manage gate for the same reason as the two
// emergency routes: the handler asks assertLeaveReviewer, which admits managers
// on the ladder and the CEO/MD as well as HR — a manager correcting their own
// report's dates should not need the HR capability to do it.
router.patch('/requests/:id/amend', amendLeaveRequest);

// PATCH /requests/:id/approve · PATCH /requests/:id/reject — decide a request
// out of turn, whoever's rung it is sitting on. Above the leave.manage gate for
// the same reason the three routes above are: the handler authorises HR *or* an
// executive itself (assertMayForceDecision), and a CEO/MD holds no capability
// while read-only — overruling leave is the office's call, not a grant's. Both
// still run the company wall, and both write the override to the request's own
// amendments trail.
router.patch('/requests/:id/approve', approveRequest);
router.patch('/requests/:id/reject', rejectRequest);

// HR/Admin — everything below requires the 'leave.manage' permission.
router.use(requirePermission('leave.manage'));

// GET /requests — list all leave requests; protected, requires 'leave.manage'.
router.get('/requests', listAllRequests);
// POST /employees/:profileId/mark — record one day of leave for an employee who
// is absent, already approved. HR's equivalent of the manager route
// (POST /manager/team/:profileId/leave): same grant, but walled by company
// instead of by direct reports, since an HR Manager usually has no reports.
router.post('/employees/:profileId/mark', markLeaveForEmployee);
// GET /balances — list employee leave balances; protected, requires 'leave.manage'.
router.get('/balances', listBalances);
// PUT /balances/:employeeId/:year — set an employee's leave balance for a year; protected, requires 'leave.manage'.
router.put('/balances/:employeeId/:year', upsertBalance);

module.exports = router;
