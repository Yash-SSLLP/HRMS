const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');

// Scope notifications to the portal a dual-role user is currently viewing.
// 'admin' → admin + all; 'employee' → employee + all; anything else → no scoping.
// Legacy docs (no `audience` field) count as 'all', so they show in both portals.
function audienceScope(audience) {
  if (audience !== 'admin' && audience !== 'employee') return {};
  return { $or: [{ audience: { $in: [audience, 'all'] } }, { audience: { $exists: false } }] };
}

// GET /api/notifications?audience=admin|employee  — recent notifications + unread count
const listNotifications = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const filter = { recipient: meId, ...audienceScope(req.query.audience) };
  const [notifications, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean(),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  res.json({ unreadCount, notifications });
});

// PATCH /api/notifications/read-all?audience=  — mark the caller's notifications
// read (scoped to the current portal so one portal's "mark all" doesn't clear the
// other's unread).
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { recipient: req.user._id, readAt: null, ...audienceScope(req.query.audience) },
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
