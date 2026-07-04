const express = require('express');
const {
  listMine,
  createRequest,
  availMine,
  listAll,
  reviewRequest,
} = require('../controllers/compOffController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self routes
router.get('/me', listMine);
router.post('/', createRequest);
router.patch('/me/:id/avail', availMine);

// Admin routes
router.use(requirePermission('leave.manage'));
router.get('/', listAll);
router.patch('/:id/status', reviewRequest);

module.exports = router;
