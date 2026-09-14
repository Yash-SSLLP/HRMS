/**
 * A person's own sending mailbox (User.mailIdentity).
 *
 * Who may connect one, how the worker turns a `sender` id into a usable
 * identity, and what to do when Google refuses the grant. The OAuth dance
 * itself lives in controllers/mailIdentityController; the MIME + Gmail call in
 * services/googleMail.
 */
const User = require('../models/User');
const secretBox = require('../utils/secretBox');
const googleOAuth = require('./googleOAuth');

// Roles whose actions send mail on the company's behalf and so may put their
// own address on it. Employees are deliberately out: the mails they trigger
// (a leave request reaching approvers) are the system's, not theirs. God is
// read-only and can never reach a write route anyway.
const SENDER_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager'];

/**
 * @param {Object} user - A User doc or lean object.
 * @returns {boolean} Whether this account may connect a sending mailbox.
 */
function canSend(user) {
  return Boolean(user && SENDER_ROLES.includes(user.role));
}

const cacheKey = (userId) => `user:${userId}`;

/**
 * Load what the Gmail service needs to send as this person, or null when they
 * have not connected a mailbox, their grant is marked broken, or the stored
 * token cannot be opened (sealed under an old key).
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<{userId:string, email:string, name:string, refreshToken:string}|null>}
 */
async function resolveIdentity(userId) {
  if (!userId || !googleOAuth.hasClient()) return null;
  const user = await User.findById(userId)
    .select('firstName lastName role isActive mailIdentity +mailIdentity.refreshToken')
    .lean();
  if (!user || !user.isActive || !canSend(user)) return null;
  const mi = user.mailIdentity || {};
  if (!mi.email || !mi.refreshToken || mi.lastError) return null;
  const refreshToken = secretBox.open(mi.refreshToken);
  if (!refreshToken) return null;
  return {
    userId: String(user._id),
    email: mi.email,
    name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
    refreshToken,
  };
}

/**
 * Record that Google refused this person's grant. From now on their mail goes
 * out from the company mailbox until they reconnect; the account page shows
 * the reason.
 * @param {string} userId
 * @param {string} message
 * @returns {Promise<void>}
 */
async function markBroken(userId, message) {
  googleOAuth.forget(cacheKey(userId));
  await User.updateOne(
    { _id: userId },
    { $set: { 'mailIdentity.lastError': String(message || 'Google refused the connection').slice(0, 500), 'mailIdentity.lastErrorAt': new Date() } }
  ).catch((err) => console.error('[mailIdentity] markBroken failed:', err.message));
}

/**
 * Note a successful send from the person's mailbox.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function markSent(userId) {
  await User.updateOne({ _id: userId }, { $set: { 'mailIdentity.lastSentAt': new Date() } })
    .catch(() => {});
}

/**
 * Store a freshly granted mailbox on the user, replacing any earlier one and
 * clearing any recorded error.
 * @param {string} userId
 * @param {{email:string, refreshToken:string}} grant
 * @returns {Promise<void>}
 */
async function connect(userId, { email, refreshToken }) {
  googleOAuth.forget(cacheKey(userId));
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'mailIdentity.email': String(email).toLowerCase(),
        'mailIdentity.refreshToken': secretBox.seal(refreshToken),
        'mailIdentity.connectedAt': new Date(),
        'mailIdentity.lastError': null,
        'mailIdentity.lastErrorAt': null,
      },
    }
  );
}

/**
 * Forget the person's mailbox: revoke the grant at Google (best effort) and
 * clear every field. Their mail returns to the company mailbox.
 * @param {string} userId
 * @returns {Promise<void>}
 */
async function disconnect(userId) {
  const user = await User.findById(userId).select('+mailIdentity.refreshToken').lean();
  const token = secretBox.open(user?.mailIdentity?.refreshToken);
  await googleOAuth.revokeToken(token);
  googleOAuth.forget(cacheKey(userId));
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'mailIdentity.email': null,
        'mailIdentity.refreshToken': null,
        'mailIdentity.connectedAt': null,
        'mailIdentity.lastSentAt': null,
        'mailIdentity.lastError': null,
        'mailIdentity.lastErrorAt': null,
      },
    }
  );
}

module.exports = { SENDER_ROLES, canSend, cacheKey, resolveIdentity, markBroken, markSent, connect, disconnect };
