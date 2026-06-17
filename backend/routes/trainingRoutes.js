const express = require('express');
const {
  listTrainings, createTraining, updateTraining, deleteTraining,
} = require('../controllers/trainingController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Everyone may view the training calendar; only HR/Admin manage it.
router.get('/', listTrainings);
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.post('/', createTraining);
router.put('/:id', updateTraining);
router.delete('/:id', deleteTraining);

module.exports = router;
