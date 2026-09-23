/**
 * Notification controller — the caller's in-app notification inbox. Lists and
 * marks notifications read, scoped by portal audience (admin/employee/all) so a
 * dual-role user only sees the relevant set, and hides alerts predating a new
 * joiner's start date.
 */
const asyncHandler = require('express-async-handler');
const Notification = require('../models/Notification');
const EmployeeProfile = require('../models/EmployeeProfile');
const { isExternalRole } = require('../utils/visibility');

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

// The notification types an OUTSIDE account (an HR consultancy — see
// utils/visibility EXTERNAL_ROLES) may read. Company-wide broadcasts —
// holidays, events, announcements, birthdays — are written to "every active
// user" by queries that predate outside accounts, so an agency's inbox would
// otherwise fill with the company's internal news. Filtering the read keeps
// every one of those writers untouched.
const EXTERNAL_NOTIFICATION_TYPES = ['consultancy'];

/** `{ type: { $in } }` for an outside account, `{}` for everyone else. */
function externalScope(user) {
  return isExternalRole(user?.role) ? { type: { $in: EXTERNAL_NOTIFICATION_TYPES } } : {};
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
  // `deletedAt: null` matches a missing field as well as an explicit null, so
  // every notification written before swipe-to-delete existed still shows.
  const filter = {
    recipient: meId, deletedAt: null, ...audienceScope(req.query.audience), ...(await joinCutoff(meId)),
    ...externalScope(req.user),
  };
  // Fifty is the ceiling AND the default: the alerts screen pages through
  // nothing, it just shows the recent ones. A home screen that renders five
  // asks for a handful instead (`?limit=`), which is the difference between a
  // fast home screen and a slow one on a phone.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 50);
  const [notifications, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  res.json({ unreadCount, notifications });
});

/**
 * The unread count on its own — what the top-bar bell badge actually shows.
 * @route GET /api/notifications/count?audience=admin|employee
 * @param {string} [req.query.audience] - portal scope: 'admin' or 'employee'
 * @returns {{unreadCount: number}}
 */
// GET /api/notifications/count?audience=  — the badge number, nothing else.
//
// The bell polls every 20 seconds to keep one integer up to date, and until
// this existed it did that by calling `listNotifications` — pulling up to 50
// whole notification documents, each with a full-length `body` paragraph, for a
// dropdown that is closed nearly all of the time. That is ~180 oversized
// responses per user per hour.
//
// It reuses `audienceScope` and `joinCutoff` VERBATIM, and that is the point of
// putting it beside the list rather than anywhere else: if the two filters ever
// drift, the badge and the list disagree — a new joiner would be badged for
// alerts that predate their joining date and then open a dropdown that
// (correctly) does not contain them, with no way to clear the badge.
const countNotifications = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  // THE SAME FILTER AS THE LIST, `deletedAt` included — see the note above this
  // function. A badge that counts what the list does not show is a badge nobody
  // can clear, which is exactly the failure that note was written about.
  const filter = {
    recipient: meId, deletedAt: null, ...audienceScope(req.query.audience), ...(await joinCutoff(meId)),
    ...externalScope(req.user),
  };
  const unreadCount = await Notification.countDocuments({ ...filter, readAt: null });
  res.json({ unreadCount });
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
    // `deletedAt` here too: "mark all read" must mean the rows on screen. Without
    // it the sweep would silently touch alerts the person has thrown away — and
    // if one were ever restored it would come back already read.
    { recipient: req.user._id, readAt: null, deletedAt: null, ...audienceScope(req.query.audience), ...(await joinCutoff(req.user._id)), ...externalScope(req.user) },
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

/**
 * Remove one notification from the caller's feed (must belong to the caller).
 *
 * Soft: it stamps `deletedAt` rather than deleting the document — see the
 * field's note on the model for why a notification is not safe to destroy.
 * `dismissedAt` goes with it, so a wish thrown away here does not reappear as a
 * greeting card on the dashboard.
 *
 * Idempotent. The phone removes the row optimistically the moment the swipe is
 * confirmed, so a retry after a dropped connection must not be an error.
 * @route DELETE /api/notifications/:id
 * @param {string} req.params.id - notification id
 * @returns {{ok: boolean, id: string}}
 */
// DELETE /api/notifications/:id — swipe-to-delete on the Alerts tab.
const deleteNotification = asyncHandler(async (req, res) => {
  const notification = await Notification.findOne({ _id: req.params.id, recipient: req.user._id });
  if (!notification) {
    res.status(404);
    throw new Error('Notification not found');
  }
  if (!notification.deletedAt) {
    const now = new Date();
    notification.deletedAt = now;
    if (!notification.dismissedAt) notification.dismissedAt = now;
    await notification.save();
  }
  res.json({ ok: true, id: String(notification._id) });
});

module.exports = {
  listNotifications, countNotifications, markAllRead, markRead, deleteNotification,
};
