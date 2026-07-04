const express = require('express');
const {
  listMine,
  createRequest,
  listAll,
  reviewRequest,
  adminCreate,
} = require('../controllers/regularizationController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self routes
router.get('/me', listMine);
router.post('/', createRequest);

// Admin routes
router.use(requirePermission('attendance.manage'));
router.get('/', listAll);
router.post('/admin', adminCreate);
router.patch('/:id/status', reviewRequest);

module.exports = router;
