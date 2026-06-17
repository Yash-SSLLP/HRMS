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

router.use(protect);

router.get('/fields', getFields);
router.route('/')
  .get(myChangeRequests)
  .post(createChangeRequest);
router.get('/assigned', assignedChangeRequests);
router.patch('/:id', decideChangeRequest);

module.exports = router;
