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

// Everyone may view the training calendar; only HR/Admin manage it.
// GET / — list trainings; protected (any authenticated user).
router.get('/', listTrainings);
// Everything below requires the 'training.manage' permission.
router.use(requirePermission('training.manage'));
// POST / — create a training; protected, requires 'training.manage'.
router.post('/', createTraining);
// PUT /:id — update a training; protected, requires 'training.manage'.
router.put('/:id', updateTraining);
// DELETE /:id — delete a training; protected, requires 'training.manage'.
router.delete('/:id', deleteTraining);

module.exports = router;
