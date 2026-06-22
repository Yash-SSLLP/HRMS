const express = require('express');
const {
  directory,
  sendRequest,
  listRequests,
  respondRequest,
  listConnections,
  getMessages,
  sendMessage,
  deleteMessage,
  clearConversation,
  adminTranscript,
  createGroup,
  listGroups,
  respondGroup,
  getGroupMessages,
  sendGroupMessage,
  clearGroup,
} = require('../controllers/chatController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// Any authenticated, active user may use chat.
router.use(protect);

router.get('/directory', directory);

router.route('/requests')
  .get(listRequests)
  .post(sendRequest);
router.patch('/requests/:id', respondRequest);

router.get('/connections', listConnections);

// SuperAdmin-only full transcript export (declared before the dynamic message
// routes so it is never shadowed).
router.get('/admin/transcript', restrictTo('SuperAdmin'), adminTranscript);

// Group chats
router.route('/groups').get(listGroups).post(createGroup);
router.patch('/groups/:id/respond', respondGroup);
router.route('/groups/:id/messages').get(getGroupMessages).post(sendGroupMessage);
router.delete('/groups/:id/messages', clearGroup);

// 1:1 messages
router.post('/messages', sendMessage);
router.get('/messages/:connectionId', getMessages);
router.delete('/messages/:messageId', deleteMessage);
router.delete('/conversations/:connectionId', clearConversation);

module.exports = router;
