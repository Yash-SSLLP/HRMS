/**
 * Manager router — mounted at /api/manager.
 * "My Team" self-service for reporting managers — every endpoint is scoped
 * to the caller's direct reports (reportingManager === me).
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { listTeam, teamPresence, listTeamLeave, approveTeamLeave, rejectTeamLeave, teamHeatmap, teamDayDetails, exportTeamAttendance } = require('../controllers/managerController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Any authenticated user may call these; every endpoint is scoped to the
// caller's own direct reports (reportingManager === me), so a non-manager
// simply sees an empty team. The "My Team" UI is shown to the Manager role.
router.use(protect);

// GET /team — list the caller's direct reports; protected (team-scoped).
router.get('/team', listTeam);
// GET /presence — team presence snapshot; protected (team-scoped).
router.get('/presence', teamPresence);
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

module.exports = router;
