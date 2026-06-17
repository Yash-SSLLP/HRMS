const express = require('express');
const {
  createComplaint,
  myComplaints,
  assignedComplaints,
  updateComplaint,
} = require('../controllers/complaintController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.route('/')
  .post(createComplaint);
router.get('/mine', myComplaints);
router.get('/assigned', assignedComplaints);
router.patch('/:id', updateComplaint);

module.exports = router;
