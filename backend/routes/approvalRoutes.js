/**
 * Approval router — mounted at /api/approvals.
 * Reporting-chain approvals for leave and exit requests, scoped to the
 * current approver (any authenticated user may be in a chain).
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listMyLeaveApprovals,
  approveLeave,
  rejectLeave,
  listMyExitApprovals,
  approveExit,
  rejectExit,
  listMyClearances,
  updateMyClearanceSection,
} = require('../controllers/approvalController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// `protect` only — deliberately NOT admin-gated. Any authenticated user can be
// an approver in someone's reporting chain (a Manager, or the read-only CEO/MD).
// Every action is scoped to `currentApprover === me` inside advanceApproval, so
// this can't be abused. This is also why CEO/MD can act here despite being
// read-only on the admin-gated routes.
router.use(protect);

// GET /leave — leave requests awaiting the current user's approval; protected (chain-scoped).
router.get('/leave', listMyLeaveApprovals);
// PATCH /leave/:id/approve — approve a leave request; protected (must be current approver).
router.patch('/leave/:id/approve', approveLeave);
// PATCH /leave/:id/reject — reject a leave request; protected (must be current approver).
router.patch('/leave/:id/reject', rejectLeave);

// GET /exits — exit requests awaiting the current user's approval; protected (chain-scoped).
router.get('/exits', listMyExitApprovals);
// PATCH /exits/:id/approve — approve an exit request; protected (must be current approver).
router.patch('/exits/:id/approve', approveExit);
// PATCH /exits/:id/reject — reject an exit request; protected (must be current approver).
router.patch('/exits/:id/reject', rejectExit);

// GET /clearances — exits with a no-dues section assigned to me; protected (assignee-scoped).
router.get('/clearances', listMyClearances);
// PATCH /clearances/:id/:key — assigned manager ticks their no-dues section; protected (assignee-scoped).
router.patch('/clearances/:id/:key', updateMyClearanceSection);

module.exports = router;
