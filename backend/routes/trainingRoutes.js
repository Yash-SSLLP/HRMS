/**
 * Training router — mounted at /api/trainings.
 * Training calendar (readable by all) plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listTrainings, createTraining, updateTraining, deleteTraining,
} = require('../controllers/trainingController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

/**
 * READING IT IS ITS OWN GRANT as of 2026-09-22 — `training.view`, held by the
 * standalone User.trainingAccess switch a SuperAdmin ticks per account, by
 * anybody holding `training.manage`, or by an L&D Manager, whose job it is.
 *
 * It used to be open to every signed-in account, which was not a decision
 * anybody made — it was what "everyone may view the calendar" turned into when
 * there was no employee-facing page to view it on. Now that there is one, who
 * sees the schedule is a question somebody answers per person.
 *
 * SOMEBODY DID LOSE THE RAW ROUTE, and an earlier draft of this note wrongly
 * said otherwise. An Accounts Manager, a Manager, and an HR Manager whose
 * capability list has been trimmed can no longer call this endpoint. None of
 * them ever had a way INTO it — the admin sidebar row has always been
 * training.manage and AdminHome sends the flat-nav roles to their own landing
 * page — so nothing on screen changes for them; a bookmarked /admin/training or
 * a direct API call is what stops working. A SuperAdmin restores it per person
 * with the Training switch on the Permissions page.
 */
// GET / — list trainings; protected, requires 'training.view'.
router.get('/', requirePermission('training.view'), listTrainings);
// Everything below requires the 'training.manage' permission.
router.use(requirePermission('training.manage'));
// POST / — create a training; protected, requires 'training.manage'.
router.post('/', createTraining);
// PUT /:id — update a training; protected, requires 'training.manage'.
router.put('/:id', updateTraining);
// DELETE /:id — delete a training; protected, requires 'training.manage'.
router.delete('/:id', deleteTraining);

module.exports = router;
