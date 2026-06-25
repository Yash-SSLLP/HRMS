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
async function notify({ recipient, type = 'general', title, body, link, data }) {
  if (!recipient || !title) throw new Error('notify requires recipient and title');

  const doc = await Notification.create({ recipient, type, title, body, link });

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
async function notifyMany(recipients, { type = 'general', title, body, link, data } = {}) {
  const ids = [...new Set((recipients || []).map(String))].filter(Boolean);
  if (!ids.length || !title) return { created: 0 };

  await Notification.insertMany(
    ids.map((recipient) => ({ recipient, type, title, body, link }))
  );

  pushToUsers(ids, {
    title,
    body,
    data: { type, link: link || null, ...(data || {}) },
  }).catch((err) => console.error('push (notifyMany) failed:', err.message));

  return { created: ids.length };
}

module.exports = { notify, notifyMany };
