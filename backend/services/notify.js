/**
 * Central notification dispatch.
 *
 * Every place that wants to notify a user should call notify()/notifyMany()
 * instead of writing to the Notification collection directly. This guarantees
 * an in-app notification AND a real-time push (Expo → FCM/APNs) go out together.
 *
 * Push is best-effort and fire-and-forget: a push failure must never break the
 * request that triggered it, so we never await it in the caller's critical path.
 *
 * `awaitPush` is the exception, and it exists for SCRIPTS. A one-off script
 * notifies, then disconnects Mongo and exits — and fire-and-forget pushes that
 * had not yet read DeviceToken die mid-flight with "Client must be connected",
 * so the in-app rows land and the phones stay silent. A script has no request to
 * protect and every reason to wait, so it passes `awaitPush: true` and the push
 * becomes part of the call. Request paths must never set it.
 */
const Notification = require('../models/Notification');
const { pushToUsers } = require('./push');

/**
 * CEO / MD HEAR ONLY WHAT THEY MUST ACT ON (2026-09-30, user: "CEO / MD
 * notification should receive only those in which they need to do action").
 *
 * Every notify()/notifyMany() call may pass `action: true` — "the recipient has
 * something to DO about this": approve or decline, review a hand-in, take on a
 * task given to them, sit an interview, answer a chase. For a CEO or MD
 * recipient a call WITHOUT it is dropped here, the bell row and the push both;
 * everybody else is untouched by the flag. So FYI news (someone's leave was
 * approved, a task moved to 60%, a holiday, a colleague's birthday) no longer
 * reaches the two of them, and a new notify call is quiet for them until
 * somebody decides it is theirs to act on.
 *
 * Not covered, deliberately: a celebration WISH sent to them is written
 * straight to the collection (celebrationsController.sendWish) — it is a person
 * writing to them, and the row is also the record the "Say thanks" reply and the
 * wish-once rule hang off.
 */
const EXEC_ROLES = ['CEO', 'MD'];

/** The subset of `ids` who are a CEO or MD. One indexed read; never throws. */
async function execIdsAmong(ids) {
  if (!ids.length) return new Set();
  try {
    // Lazy: models/User pulls in bcrypt and this module is loaded everywhere.
    const User = require('../models/User');
    const rows = await User.find({ _id: { $in: ids }, role: { $in: EXEC_ROLES } }).select('_id').lean();
    return new Set(rows.map((u) => String(u._id)));
  } catch (err) {
    console.error('notify exec filter failed:', err.message);
    return new Set();
  }
}

/**
 * Notify a single recipient.
 * @param {{recipient:string, sender?:string, type?:string, title:string, body?:string, link?:string, data?:object, action?:boolean, awaitPush?:boolean}} input
 *   `action` — the recipient must act on it; without it a CEO/MD is skipped (see above).
 * @returns {Promise<Notification|null>} null when the recipient was a CEO/MD and this was not for action
 */
async function notify({ recipient, sender, type = 'general', audience = 'all', title, body, link, data, action = false, awaitPush = false }) {
  if (!recipient || !title) throw new Error('notify requires recipient and title');
  if (!action && (await execIdsAmong([String(recipient)])).size) return null;

  // `sender` is optional and only set for person-to-person notifications, so a
  // reply can be addressed. Omitted, the field is simply absent, as it is on
  // every notification the system itself raises.
  const doc = await Notification.create({ recipient, sender, type, audience, title, body, link });

  // Fire push without blocking the caller (unless the caller asked to wait).
  const sending = pushToUsers(recipient, {
    title,
    body,
    data: { notificationId: String(doc._id), type, link: link || null, ...(data || {}) },
  }).catch((err) => console.error('push (notify) failed:', err.message));
  if (awaitPush) await sending;

  return doc;
}

/**
 * Notify many recipients of the SAME message (e.g. a new event/holiday).
 * Writes all Notification docs in one bulk insert, then pushes to all devices.
 * @param {string[]} recipients
 * @param {{type?:string, title:string, body?:string, link?:string, data?:object, action?:boolean}} input
 *   `action` — see notify(); without it any CEO/MD among `recipients` is left out.
 */
async function notifyMany(recipients, { type = 'general', audience = 'all', title, body, link, data, action = false, awaitPush = false } = {}) {
  let ids = [...new Set((recipients || []).map(String))].filter(Boolean);
  if (!ids.length || !title) return { created: 0 };
  if (!action) {
    const execs = await execIdsAmong(ids);
    if (execs.size) ids = ids.filter((id) => !execs.has(id));
    if (!ids.length) return { created: 0 };
  }

  await Notification.insertMany(
    ids.map((recipient) => ({ recipient, type, audience, title, body, link }))
  );

  const sending = pushToUsers(ids, {
    title,
    body,
    data: { type, link: link || null, ...(data || {}) },
  }).catch((err) => console.error('push (notifyMany) failed:', err.message));
  if (awaitPush) await sending;

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
