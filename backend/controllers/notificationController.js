/**
 * Notification controller — the caller's in-app notification inbox. Lists and
 * marks notifications read, scoped by portal audience (admin/employee/all) so a
 * dual-role user only sees the relevant set, and hides alerts predating a new
 * joiner's start date.
 */
const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');
const EmployeeProfile = require('../models/EmployeeProfile');

// Scope notifications to the portal a dual-role user is currently viewing.
// 'admin' → admin + all; 'employee' → employee + all; anything else → no scoping.
// Legacy docs (no `audience` field) count as 'all', so they show in both portals.
function audienceScope(audience) {
  if (audience !== 'admin' && audience !== 'employee') return {};
  return { $or: [{ audience: { $in: [audience, 'all'] } }, { audience: { $exists: false } }] };
}

// A new joiner should never see notifications that predate their joining date.
// HR usually creates the account ahead of the actual start date, and broadcast
// notifications (events, holidays, announcements, celebrations…) accumulate on
// it during that gap — so on day one the joiner would otherwise be greeted by a
// pile of alerts from before they joined. Returns a `{ createdAt: { $gte } }`
// filter fragment, or {} when there's no cutoff to apply (no profile / no
// joining date — e.g. admin-only accounts), which preserves existing behaviour.
async function joinCutoff(userId) {
  const profile = await EmployeeProfile.findOne({ user: userId }).select('dateOfJoining').lean();
  if (!profile || !profile.dateOfJoining) return {};
  return { createdAt: { $gte: profile.dateOfJoining } };
}

/**
 * List the caller's recent notifications (max 50) with an unread count.
 * @route GET /api/notifications?audience=admin|employee
 * @param {string} [req.query.audience] - portal scope: 'admin' or 'employee'
 * @returns {{unreadCount: number, notifications: Object[]}}
 */
// GET /api/notifications?audience=admin|employee  — recent notifications + unread count
const listNotifications = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const filter = { recipient: meId, ...audienceScope(req.query.audience), ...(await joinCutoff(meId)) };
  const [notifications, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(50).lean(),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  res.json({ unreadCount, notifications });
});

/**
 * Mark all the caller's unread notifications read, scoped to the current portal.
 * @route PATCH /api/notifications/read-all?audience=
 * @param {string} [req.query.audience] - portal scope: 'admin' or 'employee'
 * @returns {{ok: boolean}}
 */
// PATCH /api/notifications/read-all?audience=  — mark the caller's notifications
// read (scoped to the current portal so one portal's "mark all" doesn't clear the
// other's unread).
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { recipient: req.user._id, readAt: null, ...audienceScope(req.query.audience), ...(await joinCutoff(req.user._id)) },
    { $set: { readAt: new Date() } }
  );
  res.json({ ok: true });
});

/**
 * Mark a single notification read (must belong to the caller).
 * @route PATCH /api/notifications/:id/read
 * @param {string} req.params.id - notification id
 * @returns {{notification: Object}}
 */
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
