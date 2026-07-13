const express = require('express');
const { listTeam, teamPresence, listTeamLeave, approveTeamLeave, rejectTeamLeave, teamHeatmap, teamDayDetails } = require('../controllers/managerController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Any authenticated user may call these; every endpoint is scoped to the
// caller's own direct reports (reportingManager === me), so a non-manager
// simply sees an empty team. The "My Team" UI is shown to the Manager role.
router.use(protect);

router.get('/team', listTeam);
router.get('/presence', teamPresence);
router.get('/attendance/heatmap', teamHeatmap);
router.get('/attendance/day', teamDayDetails);
router.get('/leave-requests', listTeamLeave);
router.patch('/leave-requests/:id/approve', approveTeamLeave);
router.patch('/leave-requests/:id/reject', rejectTeamLeave);

module.exports = router;
