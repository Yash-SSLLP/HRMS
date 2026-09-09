/**
 * Complaint router — mounted at /api/complaints.
 * Employee grievance/complaint submission plus HR/handler review.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  createComplaint,
  myComplaints,
  assignedComplaints,
  updateComplaint,
  deleteComplaint,
} = require('../controllers/complaintController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// All complaint routes require a logged-in user.
router.use(protect);

// POST / — file a new complaint; protected (any authenticated user).
router.route('/')
  .post(createComplaint);
// GET /mine — list complaints raised by the current user; protected.
router.get('/mine', myComplaints);
// GET /assigned — list complaints assigned to the current user to handle; protected.
router.get('/assigned', assignedComplaints);
// PATCH /:id — update/resolve a complaint; protected (assigned handler/HR).
router.patch('/:id', updateComplaint);
// DELETE /:id - remove a RESOLVED complaint; protected (CEO/MD, HR, SuperAdmin,
// and never the person it was raised against). The status gate lives in the
// controller, not here, so the refusal can explain itself.
router.delete('/:id', deleteComplaint);

module.exports = router;
