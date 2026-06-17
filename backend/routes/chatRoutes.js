const express = require('express');
const {
  directory,
  sendRequest,
  listRequests,
  respondRequest,
  listConnections,
  getMessages,
  sendMessage,
} = require('../controllers/chatController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Any authenticated, active user may use chat.
router.use(protect);

router.get('/directory', directory);

router.route('/requests')
  .get(listRequests)
  .post(sendRequest);
router.patch('/requests/:id', respondRequest);

router.get('/connections', listConnections);

router.route('/messages')
  .post(sendMessage);
router.get('/messages/:connectionId', getMessages);

module.exports = router;
