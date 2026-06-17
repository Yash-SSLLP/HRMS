const express = require('express');
const {
  listMine,
  createRequest,
  listAll,
  reviewRequest,
} = require('../controllers/travelController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self routes
router.get('/me', listMine);
router.post('/', createRequest);

// Admin routes
router.use(restrictTo('SuperAdmin', 'HRManager'));

router.get('/', listAll);
router.patch('/:id/status', reviewRequest);

module.exports = router;
