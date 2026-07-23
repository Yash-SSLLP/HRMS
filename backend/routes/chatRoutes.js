/**
 * Chat router — mounted at /api/chat.
 * 1:1 connections/messaging plus group chats (settings, photo, members).
 * All routes require authentication (router.use(protect)).
 */
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

// GET /directory — searchable directory of chat-eligible users; protected.
router.get('/directory', directory);

// GET /requests — list connection requests; POST /requests — send one; protected.
router.route('/requests')
  .get(listRequests)
  .post(sendRequest);
// PATCH /requests/:id — accept/decline a connection request; protected.
router.patch('/requests/:id', respondRequest);

// GET /connections — list the current user's chat connections; protected.
router.get('/connections', listConnections);

// SuperAdmin-only full transcript export (declared before the dynamic message
// routes so it is never shadowed).
// GET /admin/transcript — export full chat transcript; protected, SuperAdmin only.
router.get('/admin/transcript', restrictTo('SuperAdmin'), adminTranscript);

// Group chats
// GET /groups — list groups; POST /groups — create a group; protected.
router.route('/groups').get(listGroups).post(createGroup);
// PATCH /groups/:id/respond — accept/decline a group invite; protected.
router.patch('/groups/:id/respond', respondGroup);
// GET /groups/:id/messages — fetch group messages; POST — send one; protected.
router.route('/groups/:id/messages').get(getGroupMessages).post(sendGroupMessage);
// DELETE /groups/:id/messages — clear the group conversation; protected.
router.delete('/groups/:id/messages', clearGroup);

// Group management (settings, photo, members, leave)
// /groups/:id/photo — GET fetch, POST upload (multer single 'photo', 5MB image-only), DELETE remove; protected.
router.route('/groups/:id/photo')
  .get(getGroupPhoto)
  .post(photoUpload.single('photo'), uploadGroupPhoto)
  .delete(deleteGroupPhoto);
// POST /groups/:id/members — add members to a group; protected (group admin).
router.post('/groups/:id/members', addGroupMembers);
// /groups/:id/members/:userId — PATCH set member role, DELETE remove member; protected (group admin).
router.route('/groups/:id/members/:userId').patch(setMemberRole).delete(removeGroupMember);
// POST /groups/:id/leave — leave a group; protected.
router.post('/groups/:id/leave', leaveGroup);
// Generic group detail/rename — keep last so the specific routes above win.
// GET /groups/:id — group info; PATCH /groups/:id — rename group; protected.
router.route('/groups/:id').get(getGroupInfo).patch(renameGroup);

// 1:1 messages
// POST /messages — send a direct message; protected.
router.post('/messages', sendMessage);
// GET /messages/:connectionId — fetch a 1:1 conversation's messages; protected.
router.get('/messages/:connectionId', getMessages);
// DELETE /messages/:messageId — delete a single message; protected (sender).
router.delete('/messages/:messageId', deleteMessage);
// DELETE /conversations/:connectionId — clear a 1:1 conversation; protected.
router.delete('/conversations/:connectionId', clearConversation);

module.exports = router;
