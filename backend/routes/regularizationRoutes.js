/**
 * Regularization router — mounted at /api/regularizations.
 * Attendance regularization requests plus HR/Admin review.
 * All routes require authentication (router.use(protect)).
 */
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
// GET /me — list current user's regularization requests; protected.
router.get('/me', listMine);
// POST / — raise a regularization request; protected.
router.post('/', createRequest);

// Admin routes — everything below requires the 'attendance.manage' permission.
router.use(requirePermission('attendance.manage'));
// GET / — list all regularization requests; protected, requires 'attendance.manage'.
router.get('/', listAll);
// POST /admin — create a regularization on an employee's behalf; protected, requires 'attendance.manage'.
router.post('/admin', adminCreate);
// PATCH /:id/status — approve/reject a regularization; protected, requires 'attendance.manage'.
router.patch('/:id/status', reviewRequest);

module.exports = router;
