/**
 * Change-request router — mounted at /api/change-requests.
 * Employee profile-field change requests plus approver decisions.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  getFields,
  createChangeRequest,
  myChangeRequests,
  assignedChangeRequests,
  decideChangeRequest,
} = require('../controllers/changeRequestController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// All change-request routes require a logged-in user.
router.use(protect);

// GET /fields — list fields eligible for change requests; protected.
router.get('/fields', getFields);
// GET / — list current user's change requests; POST / — raise a new one; protected.
router.route('/')
  .get(myChangeRequests)
  .post(createChangeRequest);
// GET /assigned — change requests awaiting the current user's decision; protected.
router.get('/assigned', assignedChangeRequests);
// PATCH /:id — approve/reject a change request; protected (assigned approver).
router.patch('/:id', decideChangeRequest);

module.exports = router;
