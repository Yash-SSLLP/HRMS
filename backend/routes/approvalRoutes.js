const express = require('express');
const {
  listMyLeaveApprovals,
  approveLeave,
  rejectLeave,
  listMyExitApprovals,
  approveExit,
  rejectExit,
} = require('../controllers/approvalController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// `protect` only — deliberately NOT admin-gated. Any authenticated user can be
// an approver in someone's reporting chain (a Manager, or the read-only CEO/MD).
// Every action is scoped to `currentApprover === me` inside advanceApproval, so
// this can't be abused. This is also why CEO/MD can act here despite being
// read-only on the admin-gated routes.
router.use(protect);

router.get('/leave', listMyLeaveApprovals);
router.patch('/leave/:id/approve', approveLeave);
router.patch('/leave/:id/reject', rejectLeave);

router.get('/exits', listMyExitApprovals);
router.patch('/exits/:id/approve', approveExit);
router.patch('/exits/:id/reject', rejectExit);

module.exports = router;
