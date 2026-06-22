const express = require('express');
const multer = require('multer');
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
  getGroupInfo,
  renameGroup,
  uploadGroupPhoto,
  deleteGroupPhoto,
  getGroupPhoto,
  addGroupMembers,
  removeGroupMember,
  setMemberRole,
  leaveGroup,
} = require('../controllers/chatController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB cap; accept only images for the group photo.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only image files are accepted'), ok);
  },
});

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

// Group management (settings, photo, members, leave)
router.route('/groups/:id/photo')
  .get(getGroupPhoto)
  .post(photoUpload.single('photo'), uploadGroupPhoto)
  .delete(deleteGroupPhoto);
router.post('/groups/:id/members', addGroupMembers);
router.route('/groups/:id/members/:userId').patch(setMemberRole).delete(removeGroupMember);
router.post('/groups/:id/leave', leaveGroup);
// Generic group detail/rename — keep last so the specific routes above win.
router.route('/groups/:id').get(getGroupInfo).patch(renameGroup);

// 1:1 messages
router.post('/messages', sendMessage);
router.get('/messages/:connectionId', getMessages);
router.delete('/messages/:messageId', deleteMessage);
router.delete('/conversations/:connectionId', clearConversation);

module.exports = router;
