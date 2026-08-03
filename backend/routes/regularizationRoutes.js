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
const { protect, restrictTo, requirePermission, hasPermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self routes
// GET /me — list current user's regularization requests; protected.
router.get('/me', listMine);
// POST / — raise a regularization request; protected.
router.post('/', createRequest);

// Reviewing is the one write CEO/MD are allowed: an HR's own regularization can
// only be decided by them or a SuperAdmin, so the blanket read-only exec gate
// below would leave those requests with nobody to approve them. This route
// therefore carries its own gate and must stay ABOVE the router.use() that
// follows. Who may decide WHICH request is settled in the controller.
const canReviewRegularization = (req, res, next) => {
  const role = req.user?.role;
  if (role === 'CEO' || role === 'MD' || hasPermission(req.user, 'attendance.manage')) return next();
  res.status(403);
  return next(new Error('You do not have permission for this action. Ask a SuperAdmin to grant access.'));
};
// PATCH /:id/status — approve/reject a regularization; protected, 'attendance.manage' or CEO/MD.
router.patch('/:id/status', canReviewRegularization, reviewRequest);

// Admin routes — everything below requires the 'attendance.manage' permission.
router.use(requirePermission('attendance.manage'));
// GET / — list all regularization requests; protected, requires 'attendance.manage'.
router.get('/', listAll);
// POST /admin — create a regularization on an employee's behalf; protected, requires 'attendance.manage'.
router.post('/admin', adminCreate);

module.exports = router;
