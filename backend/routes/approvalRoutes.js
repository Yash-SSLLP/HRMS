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
  countMyApprovals,
  countHrApprovals,
  listMyRegularizationApprovals,
  approveRegularization,
  rejectRegularization,
  listMyWorkOnLeave,
  approveWorkOnLeave,
  rejectWorkOnLeave,
} = require('../controllers/approvalController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// `protect` only — deliberately NOT admin-gated. Any authenticated user can be
// an approver in someone's reporting chain (a Manager, or the read-only CEO/MD).
// Every action is scoped to `currentApprover === me` inside advanceApproval, so
// this can't be abused. This is also why CEO/MD can act here despite being
// read-only on the admin-gated routes.
router.use(protect);

// GET /count — how many items await me, for the top-bar shortcut badge; protected.
// Declared before the resource routes so the literal path is never shadowed.
router.get('/count', countMyApprovals);
// GET /hr-count — how many items sit in the HR-WIDE inbox (the admin Approvals
// screen's seven category tabs), for the badge on the entry that opens it.
// Protect-only like /count: the handler gates each category on the capability
// its own list route requires and counts 0 for the rest, so there is nothing
// here for a route-level gate to add.
router.get('/hr-count', countHrApprovals);

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

// GET /regularizations — regularizations awaiting my approval; protected (chain-scoped).
// Lives here rather than on /api/regularizations because a named approver may be
// an ordinary employee, and that router gates review behind 'attendance.manage'.
router.get('/regularizations', listMyRegularizationApprovals);
// PATCH /regularizations/:id/approve — approve at my step; protected (must be current approver).
router.patch('/regularizations/:id/approve', approveRegularization);
// PATCH /regularizations/:id/reject — reject at my step; protected (must be current approver).
router.patch('/regularizations/:id/reject', rejectRegularization);

// GET /work-on-leave — days someone punched in on while on approved leave, waiting
// on me; protected (scoped to the top rung of that employee's leave hierarchy).
router.get('/work-on-leave', listMyWorkOnLeave);
// PATCH /work-on-leave/:id/approve — the leave day is returned, the day counts as worked.
router.patch('/work-on-leave/:id/approve', approveWorkOnLeave);
// PATCH /work-on-leave/:id/reject — punches kept for audit, the day stays leave.
router.patch('/work-on-leave/:id/reject', rejectWorkOnLeave);

// GET /clearances — exits with a no-dues section assigned to me; protected (assignee-scoped).
router.get('/clearances', listMyClearances);
// PATCH /clearances/:id/:key — assigned manager ticks their no-dues section; protected (assignee-scoped).
router.patch('/clearances/:id/:key', updateMyClearanceSection);

module.exports = router;
