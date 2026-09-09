/**
 * Manager router — mounted at /api/manager.
 * "My Team" self-service for reporting managers — every endpoint is scoped
 * to the caller's direct reports (reportingManager === me).
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listTeam, teamPresence, markReportOnLeave, listTeamLeave, approveTeamLeave, rejectTeamLeave,
  teamHeatmap, teamDayDetails, exportTeamAttendance,
  listTeamRestDayWork, decideTeamRestDayWork,
} = require('../controllers/managerController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Any authenticated user may call these; every endpoint is scoped to the
// caller's own direct reports (reportingManager === me), so a non-manager
// simply sees an empty team. The "My Team" UI is shown to the Manager role.
router.use(protect);

// GET /team — list the caller's direct reports; protected (team-scoped).
router.get('/team', listTeam);
// GET /presence — team presence snapshot (?date=YYYY-MM-DD); protected (team-scoped).
router.get('/presence', teamPresence);
// POST /team/:profileId/leave — put an absent direct report on leave for a day;
// protected (team-scoped). Grants through the shared leave path, so the balance,
// the attendance stamp and the employee's notification all happen as usual.
router.post('/team/:profileId/leave', markReportOnLeave);
// GET /attendance/heatmap — team attendance heatmap; protected (team-scoped).
router.get('/attendance/heatmap', teamHeatmap);
// GET /attendance/day — team attendance details for a day; protected (team-scoped).
router.get('/attendance/day', teamDayDetails);
// GET /attendance/export — export team attendance CSV; protected (team-scoped).
router.get('/attendance/export', exportTeamAttendance);
// GET /leave-requests — team leave requests awaiting the manager; protected (team-scoped).
router.get('/leave-requests', listTeamLeave);
// PATCH /leave-requests/:id/approve — approve a team member's leave; protected (team-scoped).
router.patch('/leave-requests/:id/approve', approveTeamLeave);
// PATCH /leave-requests/:id/reject — reject a team member's leave; protected (team-scoped).
router.patch('/leave-requests/:id/reject', rejectTeamLeave);
// GET /rest-day-work — Sundays / comp-off days my reports worked; protected (team-scoped).
router.get('/rest-day-work', listTeamRestDayWork);
// PATCH /rest-day-work/:id — approve/reject a report's double-pay claim; protected (team-scoped).
router.patch('/rest-day-work/:id', decideTeamRestDayWork);

module.exports = router;
