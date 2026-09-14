/**
 * A person's own sending mailbox (User.mailIdentity).
 *
 * THE RULE: email a person sends from HRMS — an offer or appointment letter, a
 * payslip, an interview invite, a document request, a birthday wish — leaves
 * from THEIR connected Google mailbox and from nowhere else. There is no quiet
 * fallback to the company mailbox: if they have not connected one, or Google
 * has stopped accepting it, the send is refused with a message that says what
 * to do (MailboxRequiredError). The company mailbox is for mail nobody
 * personally authored — leave-workflow notices, shift notices, password
 * resets, digests — which call sites mark with `sender: null`.
 *
 * Who may connect one, how the worker turns a `sender` id into a usable
 * identity, and what to do when Google refuses the grant live here. The OAuth
 * dance itself is controllers/mailIdentityController; the MIME + Gmail call is
 * services/googleMail; the calendar side is services/googleCalendar.
 */
const User = require('../models/User');
const secretBox = require('../utils/secretBox');
const googleOAuth = require('./googleOAuth');
const { currentUser } = require('../middleware/requestContext');

// Roles whose actions send mail on the company's behalf and so must put their
// own address on it. Employees are deliberately out: the mails they trigger (a
// leave request reaching approvers) are the system's, not theirs. God is
// read-only and can never reach a write route anyway.
const SENDER_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager'];

// Granted at connect time alongside gmail.send so an interview's Meet event can
// go on the person's own calendar (the invitation then comes from them too).
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * @param {Object} user - A User doc or lean object.
 * @returns {boolean} Whether this account sends mail as itself.
 */
function canSend(user) {
  return Boolean(user && SENDER_ROLES.includes(user.role));
}

const cacheKey = (userId) => `user:${userId}`;

/** Thrown when a personal send has no working mailbox behind it. 409: the
 * request is fine, the account's state is not — and one click fixes it. */
class MailboxRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MailboxRequiredError';
    this.status = 409;
    this.code = 'MAILBOX_REQUIRED';
  }
}

const MESSAGES = {
  'not-connected': 'Connect your Google mailbox first — My Account → "Send email from your own mailbox". '
    + 'Email you send from HRMS leaves only from your own address.',
  broken: 'Google has stopped accepting your mailbox connection, so this email cannot be sent. '
    + 'Reconnect it under My Account → "Send email from your own mailbox", then try again.',
  unreadable: 'Your mailbox connection needs to be made again (the server\'s key changed). '
    + 'Reconnect it under My Account → "Send email from your own mailbox", then try again.',
  unconfigured: 'Google sign-in is not configured on this server, so email cannot be sent from your own '
    + 'mailbox. Ask the Backend team to set GOOGLE_OAUTH_CLIENT_ID / _SECRET.',
  inactive: 'This account cannot send email.',
  'not-sender': 'This account does not send email as itself.',
};

/**
 * Load what the Gmail/Calendar services need to act as this person, and if
 * that is not possible, WHY — so the refusal can say the right thing.
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @returns {Promise<{identity: {userId:string, email:string, name:string, refreshToken:string, scopes:string}|null,
 *   reason: null|'unconfigured'|'inactive'|'not-sender'|'not-connected'|'broken'|'unreadable'}>}
 */
async function loadIdentity(userId) {
  if (!googleOAuth.hasClient()) return { identity: null, reason: 'unconfigured' };
  if (!userId) return { identity: null, reason: 'not-connected' };
  // Name the sub-fields one by one. Selecting the whole `mailIdentity` AND
  // `+mailIdentity.refreshToken` puts a parent path and its child in one
  // projection, which MongoDB refuses ("Path collision at
  // mailIdentity.refreshToken remaining portion refreshToken") — and that error
  // surfaced on every send, because every send resolves the sender here.
  const user = await User.findById(userId)
    .select('firstName lastName role isActive mailIdentity.email mailIdentity.scopes mailIdentity.lastError +mailIdentity.refreshToken')
    .lean();
  if (!user || !user.isActive) return { identity: null, reason: 'inactive' };
  if (!canSend(user)) return { identity: null, reason: 'not-sender' };
  const mi = user.mailIdentity || {};
  if (!mi.email || !mi.refreshToken) return { identity: null, reason: 'not-connected' };
  if (mi.lastError) return { identity: null, reason: 'broken' };
  const refreshToken = secretBox.open(mi.refreshToken);
  if (!refreshToken) return { identity: null, reason: 'unreadable' };
  return {
    identity: {
      userId: String(user._id),
      email: mi.email,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      refreshToken,
      scopes: mi.scopes || '',
    },
    reason: null,
  };
}

/**
 * The identity, or null when there is none — for callers that decide for
 * themselves what "none" means (the worker, the test-mail endpoint).
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function resolveIdentity(userId) {
  return (await loadIdentity(userId)).identity;
}

/**
 * The identity, or a MailboxRequiredError saying what to do.
 * @param {string} userId
 * @returns {Promise<Object>}
 * @throws {MailboxRequiredError}
 */
async function requireIdentity(userId) {
  const { identity, reason } = await loadIdentity(userId);
  if (identity) return identity;
  throw new MailboxRequiredError(MESSAGES[reason] || MESSAGES['not-connected']);
}

/**
 * Guard for a handler whose job is personal correspondence. An actor who sends
 * as themselves must have a working mailbox, or the request stops HERE —
 * before a letter is generated, a calendar event created, or a status stamped
 * — with the message that tells them what to connect. Anyone else (the mail is
 * the system's) passes with null.
 * @param {Object} user - req.user
 * @returns {Promise<Object|null>} The identity, or null for a non-sender role.
 * @throws {MailboxRequiredError}
 */
async function assertCanSendMail(user) {
  if (!user || !canSend(user)) return null;
  return requireIdentity(user._id);
}

/**
 * Whose mailbox a mail queued or sent inside the current request leaves from.
 *   sender === null      → nobody's: the company mailbox (a system notification).
 *   sender === undefined → the acting user of the request, if their role sends
 *                          as itself; otherwise the company mailbox.
 *   sender = <user id>   → that person.
 * A personal sender without a working mailbox is refused, never substituted.
 * @param {string|null|undefined} sender
 * @returns {Promise<{sender: string|null, identity: Object|null}>}
 * @throws {MailboxRequiredError}
 */
async function senderForContext(sender) {
  if (sender === null) return { sender: null, identity: null };
  let who = sender;
  if (who === undefined) {
    const actor = currentUser();
    if (!actor || !canSend(actor)) return { sender: null, identity: null };
    who = actor._id;
  }
  const identity = await requireIdentity(who);
  return { sender: String(who), identity };
}

/** Was calendar access granted with this connection? */
function hasCalendarScope(identity) {
  return String(identity?.scopes || '').split(/\s+/).includes(CALENDAR_SCOPE);
}

/**
 * Record that Google refused this person's grant. Their sends are refused from
 * now until they reconnect; the account page shows the reason.
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
 * @param {{email:string, refreshToken:string, scopes?:string}} grant
 * @returns {Promise<void>}
 */
async function connect(userId, { email, refreshToken, scopes }) {
  googleOAuth.forget(cacheKey(userId));
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'mailIdentity.email': String(email).toLowerCase(),
        'mailIdentity.refreshToken': secretBox.seal(refreshToken),
        'mailIdentity.scopes': String(scopes || ''),
        'mailIdentity.connectedAt': new Date(),
        'mailIdentity.lastError': null,
        'mailIdentity.lastErrorAt': null,
      },
    }
  );
}

/**
 * Forget the person's mailbox: revoke the grant at Google (best effort) and
 * clear every field. Their sends are refused until they connect again.
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
        'mailIdentity.scopes': '',
        'mailIdentity.connectedAt': null,
        'mailIdentity.lastSentAt': null,
        'mailIdentity.lastError': null,
        'mailIdentity.lastErrorAt': null,
      },
    }
  );
}

module.exports = {
  SENDER_ROLES,
  CALENDAR_SCOPE,
  MailboxRequiredError,
  canSend,
  cacheKey,
  loadIdentity,
  resolveIdentity,
  requireIdentity,
  assertCanSendMail,
  senderForContext,
  hasCalendarScope,
  markBroken,
  markSent,
  connect,
  disconnect,
};
