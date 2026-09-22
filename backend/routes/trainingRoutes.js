/**
 * Training router — mounted at /api/trainings.
 * Training calendar (readable by all) plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listTrainings, createTraining, updateTraining, deleteTraining, listTrainingPeople,
} = require('../controllers/trainingController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

/**
 * THE WHOLE MODULE IS ONE GRANT as of 2026-09-22 — `training.manage`. Whoever
 * has it sees the schedule and books on it; there is no read-only tier, by
 * decision ("whoever has access they can create that").
 *
 * It is held three ways: the capability ticked for an HR Manager or Manager,
 * the standalone User.trainingAccess switch a SuperAdmin turns on for ANY
 * account whatever its role, or the L&D Manager role, whose job it is.
 *
 * The LIST used to be open to every signed-in account, which was not a decision
 * anybody made — it was what "everyone may view the calendar" turned into when
 * there was no employee-facing page to view it on. An Accounts Manager, a
 * Manager and a trimmed HR Manager therefore lose the raw endpoint. None of
 * them ever had a way INTO it (the sidebar row has always been training.manage,
 * and AdminHome sends the flat-nav roles to their own landing page), so nothing
 * on screen changes; a bookmarked URL or a direct API call is what stops
 * working, and a SuperAdmin restores it per person with one switch.
 */
// Everything requires the 'training.manage' permission — the list included.
router.use(requirePermission('training.manage'));
// GET / — list trainings.
router.get('/', listTrainings);
// GET /people — who can be added to a training. Declared here rather than
// reusing /admin/users, which is role-gated and would 403 for the holder of the
// standalone Training grant.
router.get('/people', listTrainingPeople);
// POST / — create a training; protected, requires 'training.manage'.
router.post('/', createTraining);
// PUT /:id — update a training; protected, requires 'training.manage'.
router.put('/:id', updateTraining);
// DELETE /:id — delete a training; protected, requires 'training.manage'.
router.delete('/:id', deleteTraining);

module.exports = router;
