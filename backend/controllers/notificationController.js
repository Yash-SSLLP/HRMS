const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');

// GET /api/notifications  — recent notifications for the caller + unread count
const listNotifications = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const [notifications, unreadCount] = await Promise.all([
    Notification.find({ recipient: meId }).sort({ createdAt: -1 }).limit(50).lean(),
    Notification.countDocuments({ recipient: meId, readAt: null }),
  ]);
  res.json({ unreadCount, notifications });
});

// PATCH /api/notifications/read-all  — mark all the caller's notifications read
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { recipient: req.user._id, readAt: null },
    { $set: { readAt: new Date() } }
  );
  res.json({ ok: true });
});

// PATCH /api/notifications/:id/read  — mark one read
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!notification) {
    res.status(404);
    throw new Error('Notification not found');
  }
  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save();
  }
  res.json({ notification });
});

module.exports = { listNotifications, markAllRead, markRead };
