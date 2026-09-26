/**
 * Change-request router — mounted at /api/change-requests.
 * Employee fill-missing + change requests and approver decisions. HR edits an
 * employee's record directly (PUT /api/employees/:id, PUT /api/admin/users/:id)
 * rather than raising a request here. All routes require authentication.
 */
const express = require('express');
const {
  getFields,
  fillMissingField,
  createChangeRequest,
  myChangeRequests,
  assignedChangeRequests,
  decideChangeRequest,
} = require('../controllers/changeRequestController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// GET /fields — catalogue + current values + empty/pending flags.
router.get('/fields', getFields);
// POST /fill — fill a missing field directly (applied immediately).
router.post('/fill', fillMissingField);
// GET / — my requests; POST / — raise a change on my own filled field (→ HR).
router.route('/')
  .get(myChangeRequests)
  .post(createChangeRequest);
// GET /assigned — my approver inbox (HR partner / CEO / MD / SuperAdmin).
router.get('/assigned', assignedChangeRequests);
// PATCH /:id — approve/decline a pending request.
router.patch('/:id', decideChangeRequest);

module.exports = router;
