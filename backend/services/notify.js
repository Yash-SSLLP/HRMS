/**
 * Central notification dispatch.
 *
 * Every place that wants to notify a user should call notify()/notifyMany()
 * instead of writing to the Notification collection directly. This guarantees
 * an in-app notification AND a real-time push (Expo → FCM/APNs) go out together.
 *
 * Push is best-effort and fire-and-forget: a push failure must never break the
 * request that triggered it, so we never await it in the caller's critical path.
 */
const Notification = require('../models/Notification');
const { pushToUsers } = require('./push');

/**
 * Notify a single recipient.
 * @param {{recipient:string, type?:string, title:string, body?:string, link?:string, data?:object}} input
 * @returns {Promise<Notification>}
 */
async function notify({ recipient, type = 'general', audience = 'all', title, body, link, data }) {
  if (!recipient || !title) throw new Error('notify requires recipient and title');

  const doc = await Notification.create({ recipient, type, audience, title, body, link });

  // Fire push without blocking the caller.
  pushToUsers(recipient, {
    title,
    body,
    data: { notificationId: String(doc._id), type, link: link || null, ...(data || {}) },
  }).catch((err) => console.error('push (notify) failed:', err.message));

  return doc;
}

/**
 * Notify many recipients of the SAME message (e.g. a new event/holiday).
 * Writes all Notification docs in one bulk insert, then pushes to all devices.
 * @param {string[]} recipients
 * @param {{type?:string, title:string, body?:string, link?:string, data?:object}} input
 */
async function notifyMany(recipients, { type = 'general', audience = 'all', title, body, link, data } = {}) {
  const ids = [...new Set((recipients || []).map(String))].filter(Boolean);
  if (!ids.length || !title) return { created: 0 };

  await Notification.insertMany(
    ids.map((recipient) => ({ recipient, type, audience, title, body, link }))
  );

  pushToUsers(ids, {
    title,
    body,
    data: { type, link: link || null, ...(data || {}) },
  }).catch((err) => console.error('push (notifyMany) failed:', err.message));

  return { created: ids.length };
}

/**
 * Tell the Backend (every active SuperAdmin) that a request has been raised.
 *
 * The approvals inbox already shows a SuperAdmin every open request whoever it
 * is addressed to (approvalController's `seesAllApprovals`); this is the nudge
 * that says one has arrived, so nobody has to go and look. Deliberately fired
 * only when a request is CREATED — not on every rung it climbs — or a four-rung
 * ladder would produce four notifications for one request.
 *
 * Best-effort in the strongest sense: it swallows its own errors rather than
 * throwing, because a notification must never fail the request that caused it.
 * Recipients in `exclude` are dropped, so the SuperAdmin who is also the named
 * approver (or the person who raised it) gets one notification, not two.
 *
 * @param {object} input
 * @param {string} [input.type='general'] - Notification type tag
 * @param {string} input.title
 * @param {string} [input.body]
 * @param {string} [input.link] - 'approvals', so the click lands in the inbox
 * @param {Array} [input.exclude] - user ids already told about this one
 * @returns {Promise<{created:number}>}
 */
async function notifyBackend({ type = 'general', title, body, link, exclude = [] } = {}) {
  try {
    if (!title) return { created: 0 };
    // Lazy require: models/User pulls in bcrypt and this module is loaded by
    // nearly every controller.
    const User = require('../models/User');
    const admins = await User.find({ role: 'SuperAdmin', isActive: true }).select('_id').lean();
    const skip = new Set((exclude || []).filter(Boolean).map(String));
    const ids = admins.map((u) => String(u._id)).filter((id) => !skip.has(id));
    if (!ids.length) return { created: 0 };
    // 'admin' — a SuperAdmin only has the admin portal, and the notification
    // list is filtered by portal (see notificationController's audienceScope).
    return await notifyMany(ids, { type, audience: 'admin', title, body, link });
  } catch (err) {
    console.error('notifyBackend failed:', err.message);
    return { created: 0 };
  }
}

module.exports = { notify, notifyMany, notifyBackend };
