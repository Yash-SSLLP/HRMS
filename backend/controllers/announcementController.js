const asyncHandler = require('express-async-handler');
const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const User = require('../models/User');

// GET /api/announcements   (any authenticated user)
const listAnnouncements = asyncHandler(async (req, res) => {
  const announcements = await Announcement.find()
    .populate('createdBy', 'firstName lastName')
    .sort({ pinned: -1, createdAt: -1 });
  res.json({ count: announcements.length, announcements });
});

// POST /api/announcements   (HR/SuperAdmin) — fans out a notification to every other active user
const createAnnouncement = asyncHandler(async (req, res) => {
  const { title, body, category, pinned } = req.body;
  if (!title || !body) {
    res.status(400);
    throw new Error('title and body are required');
  }

  const announcement = await Announcement.create({
    title,
    body,
    category,
    pinned,
    createdBy: req.user._id,
  });

  // Notify all active users except the creator.
  const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
  if (recipients.length) {
    const preview = announcement.body.slice(0, 120);
    const notifications = recipients.map((u) => ({
      recipient: u._id,
      type: 'announcement',
      title: `📢 ${announcement.title}`,
      body: preview,
      link: 'announcements',
    }));
    await Notification.insertMany(notifications);
  }

  res.status(201).json({ announcement, notified: recipients.length });
});

// PUT /api/announcements/:id   (HR/SuperAdmin)
const updateAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) {
    res.status(404);
    throw new Error('Announcement not found');
  }
  delete req.body.createdBy;
  Object.assign(announcement, req.body);
  await announcement.save();
  res.json({ announcement });
});

// DELETE /api/announcements/:id   (HR/SuperAdmin)
const deleteAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) {
    res.status(404);
    throw new Error('Announcement not found');
  }
  await announcement.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
};
