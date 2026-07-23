/**
 * Announcement controller — company announcements with an optional scheduled
 * display window and per-user dismissal. Admins see all announcements; regular
 * users see only currently-active ones. Creating an announcement fans out a
 * notification to every other active user.
 */
const asyncHandler = require('express-async-handler');
const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { hasPermission } = require('../middleware/authMiddleware');

// A Mongo predicate matching docs whose optional [startDate, endDate] window
// contains `now`. Absent/null bounds are treated as open-ended.
const activeWindowQuery = (now) => ({
  $and: [
    { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
    { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: now } }] },
  ],
});

/**
 * List announcements (pinned first). Managers see all; others see only active.
 * @route GET /api/announcements   (any authenticated user)
 * @returns {{count: number, announcements: Object[]}} each with a per-user `dismissed` flag
 */
// GET /api/announcements   (any authenticated user)
// Admins (announcements.manage) see every announcement, including scheduled and
// expired ones, so they can manage them. Everyone else only sees announcements
// whose display window currently contains "now".
const listAnnouncements = asyncHandler(async (req, res) => {
  const filter = hasPermission(req.user, 'announcements.manage')
    ? {}
    : activeWindowQuery(new Date());
  const docs = await Announcement.find(filter)
    .populate('createdBy', 'firstName lastName')
    .sort({ pinned: -1, createdAt: -1 })
    .lean();
  const me = String(req.user._id);
  // Expose a per-user `dismissed` flag (used to hide it from the overview
  // banner) without leaking the full dismiss list.
  const announcements = docs.map(({ dismissedBy, ...a }) => ({
    ...a,
    dismissed: (dismissedBy || []).some((id) => String(id) === me),
  }));
  res.json({ count: announcements.length, announcements });
});

/**
 * Dismiss an announcement from the caller's overview banner (adds them to dismissedBy).
 * @route POST /api/announcements/:id/dismiss   (any authenticated user)
 * @param {string} req.params.id - announcement id
 * @returns {{id: string, dismissed: boolean}}
 */
// POST /api/announcements/:id/dismiss   (any authenticated user)
// Hides the announcement from THIS user's overview banner. It remains in the
// full Announcements feed for everyone.
const dismissAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findByIdAndUpdate(
    req.params.id,
    { $addToSet: { dismissedBy: req.user._id } },
    { new: true }
  );
  if (!announcement) {
    res.status(404);
    throw new Error('Announcement not found');
  }
  res.json({ id: req.params.id, dismissed: true });
});

/**
 * Create an announcement and notify all other active users.
 * @route POST /api/announcements   (HR/SuperAdmin)
 * @param {string} req.body.title - required
 * @param {string} req.body.body - required
 * @param {string} [req.body.category]
 * @param {boolean} [req.body.pinned]
 * @param {string} [req.body.startDate]
 * @param {string} [req.body.endDate]
 * @returns {{announcement: Object, notified: number}} (201)
 * @sideeffect inserts a notification for every active user except the creator
 */
// POST /api/announcements   (HR/SuperAdmin) — fans out a notification to every other active user
const createAnnouncement = asyncHandler(async (req, res) => {
  const { title, body, category, pinned, startDate, endDate } = req.body;
  if (!title || !body) {
    res.status(400);
    throw new Error('title and body are required');
  }

  const announcement = await Announcement.create({
    title,
    body,
    category,
    pinned,
    startDate: startDate || undefined,
    endDate: endDate || undefined,
    createdBy: req.user._id,
  });

  // Notify all active users except the creator. Only the title goes in the
  // notification — the full body is read on the Announcements page.
  const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
  if (recipients.length) {
    const notifications = recipients.map((u) => ({
      recipient: u._id,
      type: 'announcement',
      title: `📢 ${announcement.title}`,
      body: 'Tap to read the full announcement.',
      link: 'announcements',
    }));
    await Notification.insertMany(notifications);
  }

  res.status(201).json({ announcement, notified: recipients.length });
});

/**
 * Update an announcement (partial).
 * @route PUT /api/announcements/:id   (HR/SuperAdmin)
 * @param {string} req.params.id - announcement id
 * @param {Object} req.body - fields to update
 * @returns {{announcement: Object}}
 */
// PUT /api/announcements/:id   (HR/SuperAdmin)
const updateAnnouncement = asyncHandler(async (req, res) => {
  const announcement = await Announcement.findById(req.params.id);
  if (!announcement) {
    res.status(404);
    throw new Error('Announcement not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(announcement, req.body);
  await announcement.save();
  res.json({ announcement });
});

/**
 * Delete an announcement by id.
 * @route DELETE /api/announcements/:id   (HR/SuperAdmin)
 * @param {string} req.params.id - announcement id
 * @returns {{id: string, deleted: boolean}}
 */
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
  dismissAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
};
