/**
 * Chat controller — internal messaging over HTTP polling. Covers 1:1 chats built
 * on connection requests (Connection) with WhatsApp-style sent/delivered/seen
 * ticks and incremental after-cursor sync, plus group chats (ChatGroup) with
 * invites, roles (owner/admin/member), photos and management. People who have left
 * the org (deactivated or past dateOfExit) are blocked from being messaged.
 * Messages soft-delete per user; a SuperAdmin transcript export sees everything.
 */
const asyncHandler = require('express-async-handler');
const path = require('path');
const Connection = require('../models/Connection');
const Message = require('../models/Message');
const ChatGroup = require('../models/ChatGroup');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const storage = require('../services/storage');
const { hideSuperAdminFilter } = require('../utils/visibility');
const { notify, notifyMany } = require('../services/notify');

// Trim a chat body to a notification-friendly preview.
function preview(text) {
  const clean = (text || '').trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
}

const USER_FIELDS = 'firstName lastName email role photo isActive';

function publicUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
    email: u.email,
    role: u.role,
    hasPhoto: Boolean(u.photo),
    // A deactivated login = the person has left the organization. The chat UI
    // shows a "Resigned" badge and blocks messaging them.
    resigned: u.isActive === false,
  };
}

// Resolve the "other" participant id of a connection relative to the caller.
function otherParty(conn, meId) {
  return conn.requester.equals(meId) ? conn.recipient : conn.requester;
}

// Given a list of user ids, return the set (as strings) of those who have LEFT
// the organization — either their login is deactivated OR their employee profile
// has a date of exit that has already passed. Used to block chatting with them.
async function departedUserIdSet(userIds) {
  const ids = [...new Set((userIds || []).map(String))].filter(Boolean);
  if (!ids.length) return new Set();
  const departed = new Set();
  const [inactive, profiles] = await Promise.all([
    User.find({ _id: { $in: ids }, isActive: false }).select('_id').lean(),
    EmployeeProfile.find({ user: { $in: ids }, dateOfExit: { $ne: null, $lte: new Date() } }).select('user').lean(),
  ]);
  inactive.forEach((u) => departed.add(String(u._id)));
  profiles.forEach((p) => departed.add(String(p.user)));
  return departed;
}

// WhatsApp-style delivery status for a message (from the sender's viewpoint).
//  sent      → stored on the server, not yet pulled by the recipient
//  delivered → the recipient's client has fetched it (single → double tick)
//  seen      → the recipient opened the conversation (double blue tick)
function messageStatus(m) {
  if (m.readAt) return 'seen';
  if (m.deliveredAt) return 'delivered';
  return 'sent';
}

/**
 * List active users (except self) with the caller's connection status to each.
 * @route GET /api/chat/directory
 * @returns {{count: number, people: Object[]}} each with connectionStatus/connectionId; departed users excluded
 */
// GET /api/chat/directory  — active users (except self) with the caller's
// connection status to each. Reused by the complaints target picker.
const directory = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const activeUsers = await User.find({ isActive: true, _id: { $ne: meId }, ...hideSuperAdminFilter(req.user) })
    .select(USER_FIELDS)
    .sort({ firstName: 1, lastName: 1 });

  // Exclude anyone who has left the org (a past dateOfExit) even if their login
  // hasn't been deactivated yet — you can't start a chat with someone who's gone.
  const departed = await departedUserIdSet(activeUsers.map((u) => u._id));
  const users = activeUsers.filter((u) => !departed.has(String(u._id)));

  const conns = await Connection.find({
    $or: [{ requester: meId }, { recipient: meId }],
  });

  const byOther = new Map();
  for (const c of conns) {
    const other = String(otherParty(c, meId));
    let status = 'none';
    if (c.status === 'accepted') status = 'accepted';
    else if (c.status === 'pending') status = c.requester.equals(meId) ? 'pending-out' : 'pending-in';
    byOther.set(other, { status, connectionId: c._id });
  }

  const people = users.map((u) => ({
    ...publicUser(u),
    connectionStatus: byOther.get(String(u._id))?.status || 'none',
    connectionId: byOther.get(String(u._id))?.connectionId || null,
  }));

  res.json({ count: people.length, people });
});

/**
 * Send a connection request (SuperAdmin requests are auto-accepted).
 * @route POST /api/chat/requests
 * @param {string} req.body.recipientId - required, not self, not departed
 * @returns {{connection: Object}} (201); 409 if already connected/pending
 */
// POST /api/chat/requests  { recipientId }
const sendRequest = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { recipientId } = req.body;
  if (!recipientId) {
    res.status(400);
    throw new Error('recipientId is required');
  }
  if (String(recipientId) === String(meId)) {
    res.status(400);
    throw new Error('You cannot connect with yourself');
  }

  const recipient = await User.findOne({ _id: recipientId, isActive: true });
  if (!recipient) {
    res.status(404);
    throw new Error('User not found');
  }
  const departed = await departedUserIdSet([recipientId]);
  if (departed.has(String(recipientId))) {
    res.status(403);
    throw new Error('This person has left the organization');
  }

  // A SuperAdmin may message anyone without waiting for approval — their
  // connections are accepted immediately (and any pending request is accepted).
  const isSuper = req.user.role === 'SuperAdmin';
  const initialStatus = isSuper ? 'accepted' : 'pending';

  const pairKey = Connection.buildPairKey(meId, recipientId);
  let conn = await Connection.findOne({ pairKey });

  if (conn) {
    if (conn.status === 'accepted') {
      res.status(409);
      throw new Error('You are already connected');
    }
    if (conn.status === 'pending') {
      // SuperAdmin: instantly accept whichever direction is pending.
      if (isSuper) {
        conn.status = 'accepted';
        await conn.save();
        return res.status(201).json({ connection: conn });
      }
      res.status(409);
      throw new Error('A request is already pending');
    }
    // Previously declined — revive from the caller (auto-accepted for SuperAdmin).
    conn.requester = meId;
    conn.recipient = recipientId;
    conn.status = initialStatus;
    await conn.save();
  } else {
    conn = await Connection.create({ requester: meId, recipient: recipientId, status: initialStatus });
  }

  res.status(201).json({ connection: conn });
});

/**
 * List the caller's pending connection requests, split by direction.
 * @route GET /api/chat/requests
 * @returns {{incoming: Object[], outgoing: Object[]}}
 */
// GET /api/chat/requests  — pending requests, split into incoming/outgoing
const listRequests = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const pending = await Connection.find({ status: 'pending', $or: [{ requester: meId }, { recipient: meId }] })
    .populate('requester', USER_FIELDS)
    .populate('recipient', USER_FIELDS)
    .sort({ updatedAt: -1 });

  const incoming = [];
  const outgoing = [];
  for (const c of pending) {
    if (c.recipient._id.equals(meId)) {
      incoming.push({ _id: c._id, from: publicUser(c.requester), createdAt: c.createdAt });
    } else {
      outgoing.push({ _id: c._id, to: publicUser(c.recipient), createdAt: c.createdAt });
    }
  }
  res.json({ incoming, outgoing });
});

/**
 * Accept or decline an incoming connection request (recipient only).
 * @route PATCH /api/chat/requests/:id
 * @param {string} req.params.id - connection id
 * @param {string} req.body.action - 'accept' or 'decline'
 * @returns {{connection: Object}}
 */
// PATCH /api/chat/requests/:id  { action: 'accept' | 'decline' }
const respondRequest = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { action } = req.body;
  if (!['accept', 'decline'].includes(action)) {
    res.status(400);
    throw new Error("action must be 'accept' or 'decline'");
  }

  const conn = await Connection.findById(req.params.id);
  if (!conn || conn.status !== 'pending') {
    res.status(404);
    throw new Error('Request not found');
  }
  if (!conn.recipient.equals(meId)) {
    res.status(403);
    throw new Error('Only the recipient can respond to this request');
  }

  conn.status = action === 'accept' ? 'accepted' : 'declined';
  await conn.save();
  res.json({ connection: conn });
});

/**
 * List the caller's accepted 1:1 conversations with last message and unread count.
 * @route GET /api/chat/connections
 * @returns {{count: number, connections: Object[]}}
 * @sideeffect marks messages addressed to the caller as delivered
 */
// GET /api/chat/connections  — accepted connections with last message + unread count
const listConnections = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const conns = await Connection.find({ status: 'accepted', $or: [{ requester: meId }, { recipient: meId }] })
    .populate('requester', USER_FIELDS)
    .populate('recipient', USER_FIELDS)
    .sort({ updatedAt: -1 });

  // The caller is online and polling — mark messages addressed to them as
  // delivered so the sender sees double ticks even before they're opened.
  await Message.updateMany(
    { connection: { $in: conns.map((c) => c._id) }, sender: { $ne: meId }, deliveredAt: null },
    { $set: { deliveredAt: new Date() } }
  );

  // Flag the other parties who have left the organization so the client shows a
  // "Resigned" badge and blocks messaging (covers dateOfExit-only departures too).
  const otherIds = conns.map((c) => (c.requester._id.equals(meId) ? c.recipient._id : c.requester._id));
  const departed = await departedUserIdSet(otherIds);

  const out = await Promise.all(
    conns.map(async (c) => {
      const other = c.requester._id.equals(meId) ? c.recipient : c.requester;
      const lastMessage = await Message.findOne({ connection: c._id, deletedFor: { $ne: meId } }).sort({ createdAt: -1 });
      const unread = await Message.countDocuments({
        connection: c._id,
        sender: { $ne: meId },
        readAt: null,
        deletedFor: { $ne: meId },
      });
      const person = publicUser(other);
      person.resigned = person.resigned || departed.has(String(other._id));
      return {
        connectionId: c._id,
        person,
        lastMessage: lastMessage
          ? { body: lastMessage.body, createdAt: lastMessage.createdAt, mine: lastMessage.sender.equals(meId) }
          : null,
        unread,
      };
    })
  );

  res.json({ count: out.length, connections: out });
});

// Shared guard: load an accepted connection the caller participates in.
async function loadParticipantConnection(connectionId, meId) {
  const conn = await Connection.findById(connectionId);
  if (!conn || conn.status !== 'accepted') {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  if (!conn.requester.equals(meId) && !conn.recipient.equals(meId)) {
    const err = new Error('You are not a participant in this conversation');
    err.status = 403;
    throw err;
  }
  return conn;
}

/**
 * Fetch a 1:1 thread (full or incremental via ?after) and mark the other party's
 * messages delivered + read.
 * @route GET /api/chat/messages/:connectionId
 * @param {string} req.params.connectionId - connection id
 * @param {string} [req.query.after] - ISO cursor for incremental sync
 * @returns {{incremental, seenUpTo, deliveredUpTo, messages}}
 */
// GET /api/chat/messages/:connectionId  — thread; marks the other party's messages read
const getMessages = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  await loadParticipantConnection(req.params.connectionId, meId);

  const now = new Date();
  // Opening the thread marks the other party's messages as both delivered
  // (if a poll hadn't already) and read/seen.
  await Message.updateMany(
    { connection: req.params.connectionId, sender: { $ne: meId }, deliveredAt: null },
    { $set: { deliveredAt: now } }
  );
  await Message.updateMany(
    { connection: req.params.connectionId, sender: { $ne: meId }, readAt: null },
    { $set: { readAt: now } }
  );

  // Incremental sync: when the client passes ?after=<ISO>, return only messages
  // newer than that cursor so polls stay tiny instead of re-sending the whole
  // thread. First load (no cursor) returns everything.
  const after = req.query.after ? new Date(req.query.after) : null;
  const incremental = !!(after && !Number.isNaN(after.getTime()));
  const filter = { connection: req.params.connectionId, deletedFor: { $ne: meId } };
  if (incremental) filter.createdAt = { $gt: after };

  const messages = await Message.find(filter).sort({ createdAt: 1 }).lean();

  // "Read up to" markers so the sender's ticks upgrade to delivered/seen without
  // re-fetching their own old messages: the latest of MY messages the other party
  // has delivered/read. The client marks all its messages up to these as such.
  const lastSeen = await Message.findOne({ connection: req.params.connectionId, sender: meId, readAt: { $ne: null } })
    .sort({ readAt: -1 }).select('createdAt').lean();
  const lastDelivered = await Message.findOne({ connection: req.params.connectionId, sender: meId, deliveredAt: { $ne: null } })
    .sort({ deliveredAt: -1 }).select('createdAt').lean();

  res.json({
    incremental,
    seenUpTo: lastSeen?.createdAt || null,
    deliveredUpTo: lastDelivered?.createdAt || null,
    messages: messages.map((m) => ({
      _id: m._id,
      body: m.body,
      createdAt: m.createdAt,
      mine: String(m.sender) === String(meId),
      status: messageStatus(m),
    })),
  });
});

/**
 * Send a 1:1 message (blocked if the recipient has left the org).
 * @route POST /api/chat/messages
 * @param {string} req.body.connectionId - required (caller must be a participant)
 * @param {string} req.body.body - required
 * @returns {{message: Object}} (201)
 * @sideeffect notifies the recipient (in-app + push)
 */
// POST /api/chat/messages  { connectionId, body }
const sendMessage = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { connectionId, body } = req.body;
  if (!connectionId || !body || !body.trim()) {
    res.status(400);
    throw new Error('connectionId and body are required');
  }
  const conn = await loadParticipantConnection(connectionId, meId);

  // Block messaging someone who has left the organization (deactivated login OR
  // an employee profile whose date of exit has passed).
  const recipientId = otherParty(conn, meId);
  const departed = await departedUserIdSet([recipientId]);
  if (departed.has(String(recipientId))) {
    res.status(403);
    throw new Error('This person has left the organization and can no longer be messaged');
  }

  const message = await Message.create({ connection: connectionId, sender: meId, body: body.trim() });

  // Notify the other party (in-app + push). Best-effort — never block the send.
  const fromName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'New message';
  notify({
    recipient: recipientId,
    type: 'chat',
    title: fromName,
    body: preview(body),
    link: 'chat',
    data: { connectionId: String(connectionId) },
  }).catch((err) => console.error('chat notify failed:', err.message));

  res.status(201).json({
    message: { _id: message._id, body: message.body, createdAt: message.createdAt, mine: true, status: 'sent' },
  });
});

// ===== Soft delete (hide for me; never removed from the DB) =====

/**
 * Soft-delete a single message from the caller's own view (kept in the DB).
 * @route DELETE /api/chat/messages/:messageId
 * @param {string} req.params.messageId - message id (caller must be a participant/member)
 * @returns {{ok: true}}
 */
// DELETE /api/chat/messages/:messageId — hide a single message from my view.
const deleteMessage = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const message = await Message.findById(req.params.messageId);
  if (!message) {
    res.status(404);
    throw new Error('Message not found');
  }
  if (message.connection) {
    const conn = await Connection.findById(message.connection);
    if (!conn || (!conn.requester.equals(meId) && !conn.recipient.equals(meId))) {
      res.status(403);
      throw new Error('You are not a participant in this conversation');
    }
  } else if (message.group) {
    const group = await ChatGroup.findById(message.group);
    const mem = group && group.memberFor(meId);
    if (!mem || mem.status !== 'accepted') {
      res.status(403);
      throw new Error('You are not a member of this group');
    }
  }
  await Message.updateOne({ _id: message._id }, { $addToSet: { deletedFor: meId } });
  res.json({ ok: true });
});

/**
 * Clear an entire 1:1 conversation from the caller's own view.
 * @route DELETE /api/chat/conversations/:connectionId
 * @param {string} req.params.connectionId - connection id
 * @returns {{ok: true}}
 */
// DELETE /api/chat/conversations/:connectionId — clear a 1:1 chat from my view.
const clearConversation = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  await loadParticipantConnection(req.params.connectionId, meId);
  await Message.updateMany({ connection: req.params.connectionId }, { $addToSet: { deletedFor: meId } });
  res.json({ ok: true });
});

// ===== SuperAdmin transcript export (includes deleted messages) =====

/**
 * SuperAdmin: full transcript of a 1:1 pair or a group, including soft-deleted messages.
 * @route GET /api/chat/admin/transcript?userA=&userB=  (or ?groupId=)
 * @param {string} [req.query.userA] / [req.query.userB] - the 1:1 pair
 * @param {string} [req.query.groupId] - a group instead
 * @returns {{meta, messages}} messages flagged with deleted/deletedBy
 */
// GET /api/chat/admin/transcript?userA=&userB=   (or ?groupId=)
const adminTranscript = asyncHandler(async (req, res) => {
  const { userA, userB, groupId } = req.query;
  const shape = (msgs) => msgs.map((m) => ({
    _id: m._id,
    body: m.body,
    sender: publicUser(m.sender),
    createdAt: m.createdAt,
    deleted: (m.deletedFor || []).length > 0,
    deletedBy: (m.deletedFor || []).map((u) => `${u.firstName || ''} ${u.lastName || ''}`.trim()),
  }));

  if (groupId) {
    const group = await ChatGroup.findById(groupId).populate('members.user', USER_FIELDS).lean();
    if (!group) { res.status(404); throw new Error('Group not found'); }
    const messages = await Message.find({ group: groupId }).sort({ createdAt: 1 })
      .populate('sender', USER_FIELDS).populate('deletedFor', 'firstName lastName').lean();
    return res.json({
      meta: { type: 'group', name: group.name, members: group.members.map((m) => publicUser(m.user)) },
      messages: shape(messages),
    });
  }

  if (!userA || !userB) {
    res.status(400);
    throw new Error('userA and userB are required');
  }
  const conn = await Connection.findOne({ pairKey: Connection.buildPairKey(userA, userB) });
  const [a, b] = await Promise.all([
    User.findById(userA).select(USER_FIELDS),
    User.findById(userB).select(USER_FIELDS),
  ]);
  if (!conn) {
    return res.json({ meta: { type: 'direct', a: publicUser(a), b: publicUser(b) }, messages: [] });
  }
  const messages = await Message.find({ connection: conn._id }).sort({ createdAt: 1 })
    .populate('sender', USER_FIELDS).populate('deletedFor', 'firstName lastName').lean();
  res.json({ meta: { type: 'direct', a: publicUser(a), b: publicUser(b) }, messages: shape(messages) });
});

// ===== Group chats =====

/**
 * Create a group chat; the creator is owner, others are invited.
 * @route POST /api/chat/groups
 * @param {string} req.body.name - required
 * @param {string[]} [req.body.memberIds] - users to invite (active only, self removed)
 * @returns {{group: {groupId, name, invited}}} (201)
 */
// POST /api/chat/groups  { name, memberIds: [] }
const createGroup = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { name, memberIds } = req.body;
  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('Group name is required');
  }
  let ids = Array.isArray(memberIds) ? [...new Set(memberIds.map(String))] : [];
  ids = ids.filter((id) => id !== String(meId));
  // Only active users; SuperAdmin can't be added by a non-SuperAdmin (hidden).
  const valid = await User.find({ _id: { $in: ids }, isActive: true, ...hideSuperAdminFilter(req.user) }).select('_id');
  const members = [
    { user: meId, role: 'owner', status: 'accepted', respondedAt: new Date(), lastReadAt: new Date() },
    ...valid.map((u) => ({ user: u._id, role: 'member', status: 'invited' })),
  ];
  const group = await ChatGroup.create({ name: name.trim(), createdBy: meId, members });
  res.status(201).json({ group: { groupId: group._id, name: group.name, invited: valid.length } });
});

/**
 * List the caller's accepted groups (with last message/unread) and pending invites.
 * @route GET /api/chat/groups
 * @returns {{groups: Object[], invites: Object[]}}
 */
// GET /api/chat/groups  — my accepted groups + my pending invites
const listGroups = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const groups = await ChatGroup.find({ 'members.user': meId })
    .populate('members.user', USER_FIELDS)
    .sort({ updatedAt: -1 });

  const mine = [];
  const invites = [];
  for (const g of groups) {
    const mem = g.memberFor(meId);
    if (!mem) continue;
    if (mem.status === 'accepted') {
      const lastMessage = await Message.findOne({ group: g._id, deletedFor: { $ne: meId } }).sort({ createdAt: -1 });
      const unread = await Message.countDocuments({
        group: g._id,
        sender: { $ne: meId },
        deletedFor: { $ne: meId },
        ...(mem.lastReadAt ? { createdAt: { $gt: mem.lastReadAt } } : {}),
      });
      mine.push({
        groupId: g._id,
        name: g.name,
        hasPhoto: Boolean(g.photo),
        myRole: mem.role,
        memberCount: g.members.filter((m) => m.status === 'accepted').length,
        lastMessage: lastMessage
          ? { body: lastMessage.body, createdAt: lastMessage.createdAt, mine: lastMessage.sender.equals(meId) }
          : null,
        unread,
      });
    } else if (mem.status === 'invited') {
      const owner = g.members.find((m) => m.role === 'owner');
      invites.push({ groupId: g._id, name: g.name, hasPhoto: Boolean(g.photo), from: publicUser(owner?.user), invitedAt: mem.invitedAt, memberCount: g.members.length });
    }
  }
  res.json({ groups: mine, invites });
});

/**
 * Accept or decline a group invite.
 * @route PATCH /api/chat/groups/:id/respond
 * @param {string} req.params.id - group id
 * @param {string} req.body.action - 'accept' or 'decline'
 * @returns {{ok: true}}
 */
// PATCH /api/chat/groups/:id/respond  { action: 'accept' | 'decline' }
const respondGroup = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { action } = req.body;
  if (!['accept', 'decline'].includes(action)) {
    res.status(400);
    throw new Error("action must be 'accept' or 'decline'");
  }
  const group = await ChatGroup.findById(req.params.id);
  const mem = group && group.memberFor(meId);
  if (!group || !mem || mem.status !== 'invited') {
    res.status(404);
    throw new Error('No pending invite for this group');
  }
  mem.status = action === 'accept' ? 'accepted' : 'declined';
  mem.respondedAt = new Date();
  if (action === 'accept') mem.lastReadAt = new Date();
  await group.save();
  res.json({ ok: true });
});

// Shared guard: load a group the caller is an accepted member of.
async function loadGroupForMember(groupId, meId) {
  const group = await ChatGroup.findById(groupId);
  const mem = group && group.memberFor(meId);
  if (!group || !mem || mem.status !== 'accepted') {
    const err = new Error('You are not a member of this group');
    err.status = 403;
    throw err;
  }
  return { group, mem };
}

/**
 * Fetch a group thread (full or incremental via ?after) and mark it read.
 * @route GET /api/chat/groups/:id/messages
 * @param {string} req.params.id - group id (caller must be an accepted member)
 * @param {string} [req.query.after] - ISO cursor for incremental sync
 * @returns {{name, hasPhoto, myRole, memberCount, incremental, messages}}
 */
// GET /api/chat/groups/:id/messages
const getGroupMessages = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { group, mem } = await loadGroupForMember(req.params.id, meId);
  mem.lastReadAt = new Date();
  await group.save();

  // Incremental sync: ?after=<ISO> returns only newer messages (tiny polls).
  const after = req.query.after ? new Date(req.query.after) : null;
  const incremental = !!(after && !Number.isNaN(after.getTime()));
  const filter = { group: group._id, deletedFor: { $ne: meId } };
  if (incremental) filter.createdAt = { $gt: after };

  const messages = await Message.find(filter)
    .sort({ createdAt: 1 })
    .populate('sender', 'firstName lastName')
    .lean();

  res.json({
    name: group.name,
    hasPhoto: Boolean(group.photo),
    myRole: mem.role,
    memberCount: group.members.filter((m) => m.status === 'accepted').length,
    incremental,
    messages: messages.map((m) => ({
      _id: m._id,
      body: m.body,
      createdAt: m.createdAt,
      mine: String(m.sender?._id || m.sender) === String(meId),
      senderName: `${m.sender?.firstName || ''} ${m.sender?.lastName || ''}`.trim(),
    })),
  });
});

/**
 * Send a group message.
 * @route POST /api/chat/groups/:id/messages
 * @param {string} req.params.id - group id (caller must be an accepted member)
 * @param {string} req.body.body - required
 * @returns {{message: Object}} (201)
 * @sideeffect notifies every other accepted member (in-app + push)
 */
// POST /api/chat/groups/:id/messages  { body }
const sendGroupMessage = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { body } = req.body;
  if (!body || !body.trim()) {
    res.status(400);
    throw new Error('body is required');
  }
  const { group } = await loadGroupForMember(req.params.id, meId);
  const message = await Message.create({ group: group._id, sender: meId, body: body.trim() });
  group.markModified('updatedAt');
  await group.save(); // bump updatedAt so the group rises in the list

  // Notify every other accepted member (in-app + push).
  const recipients = group.members
    .filter((m) => m.status === 'accepted' && String(m.user?._id || m.user) !== String(meId))
    .map((m) => m.user?._id || m.user);
  const fromName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'Someone';
  notifyMany(recipients, {
    type: 'chat',
    title: group.name,
    body: `${fromName}: ${preview(body)}`,
    link: 'chat',
    data: { groupId: String(group._id) },
  }).catch((err) => console.error('group notify failed:', err.message));

  res.status(201).json({
    message: { _id: message._id, body: message.body, createdAt: message.createdAt, mine: true, senderName: req.user.fullName },
  });
});

/**
 * Clear a group chat from the caller's own view.
 * @route DELETE /api/chat/groups/:id/messages
 * @param {string} req.params.id - group id
 * @returns {{ok: true}}
 */
// DELETE /api/chat/groups/:id/messages — clear a group chat from my view.
const clearGroup = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { group } = await loadGroupForMember(req.params.id, meId);
  await Message.updateMany({ group: group._id }, { $addToSet: { deletedFor: meId } });
  res.json({ ok: true });
});

// ===== Group management (admin actions, leave, settings) =====

// Shared guard: load a group the caller manages (owner or admin).
async function loadGroupForManager(groupId, meId) {
  const group = await ChatGroup.findById(groupId);
  if (!group || !group.isManager(meId)) {
    const err = new Error('Only the group owner or an admin can do that');
    err.status = 403;
    throw err;
  }
  return group;
}

// Shape a member sub-doc (with populated user) for the settings panel.
function shapeMember(m) {
  return { ...publicUser(m.user), role: m.role, status: m.status };
}

/**
 * Full group detail (members, roles) for the settings panel.
 * @route GET /api/chat/groups/:id
 * @param {string} req.params.id - group id (caller must be an accepted member)
 * @returns {{groupId, name, hasPhoto, myRole, createdBy, members}}
 */
// GET /api/chat/groups/:id — full group detail for the settings panel.
const getGroupInfo = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const group = await ChatGroup.findById(req.params.id).populate('members.user', USER_FIELDS);
  const mem = group && group.memberFor(meId);
  if (!group || !mem || mem.status !== 'accepted') {
    res.status(403);
    throw new Error('You are not a member of this group');
  }
  // Accepted members first, then pending invites; owner/admin sorted to the top.
  const order = { owner: 0, admin: 1, member: 2 };
  const members = group.members
    .filter((m) => m.user && m.status !== 'declined')
    .sort((a, b) => (order[a.role] - order[b.role]))
    .map(shapeMember);
  res.json({
    groupId: group._id,
    name: group.name,
    hasPhoto: Boolean(group.photo),
    myRole: mem.role,
    createdBy: String(group.createdBy),
    members,
  });
});

/**
 * Rename a group (owner/admin).
 * @route PATCH /api/chat/groups/:id
 * @param {string} req.params.id - group id
 * @param {string} req.body.name - required (truncated to 80 chars)
 * @returns {{ok: true, name}}
 */
// PATCH /api/chat/groups/:id  { name } — rename the group (owner/admin).
const renameGroup = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('Group name is required');
  }
  const group = await loadGroupForManager(req.params.id, meId);
  group.name = name.trim().slice(0, 80);
  await group.save();
  res.json({ ok: true, name: group.name });
});

/**
 * Set a group photo (owner/admin), replacing any existing one.
 * @route POST /api/chat/groups/:id/photo  (multipart field: photo)
 * @param {string} req.params.id - group id
 * @param {File} req.file - the image (required)
 * @returns {{ok: true}}
 */
// POST /api/chat/groups/:id/photo  (multipart: photo) — set group photo (owner/admin).
const uploadGroupPhoto = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  if (!req.file) {
    res.status(400);
    throw new Error('A photo is required');
  }
  const group = await loadGroupForManager(req.params.id, meId);
  const { storagePath } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'groups',
    ownerId: group._id,
    originalName: req.file.originalname || 'group.jpg',
  });
  const previous = group.photo;
  group.photo = storagePath;
  await group.save();
  if (previous && previous !== storagePath) {
    try { storage.remove(previous); } catch { /* best effort */ }
  }
  res.json({ ok: true });
});

/**
 * Remove a group photo (owner/admin).
 * @route DELETE /api/chat/groups/:id/photo
 * @param {string} req.params.id - group id
 * @returns {{ok: true}}
 */
// DELETE /api/chat/groups/:id/photo — remove group photo (owner/admin).
const deleteGroupPhoto = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const group = await loadGroupForManager(req.params.id, meId);
  if (group.photo) {
    try { storage.remove(group.photo); } catch { /* best effort */ }
    group.photo = null;
    await group.save();
  }
  res.json({ ok: true });
});

/**
 * Stream a group photo (accepted members only).
 * @route GET /api/chat/groups/:id/photo
 * @param {string} req.params.id - group id
 * @returns {binary} the image; 403 if not a member, 404 if none
 */
// GET /api/chat/groups/:id/photo — stream the group photo (members only).
const getGroupPhoto = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const group = await ChatGroup.findById(req.params.id).select('photo members');
  const mem = group && group.memberFor(meId);
  if (!group || !mem || mem.status !== 'accepted') {
    res.status(403);
    throw new Error('You are not a member of this group');
  }
  if (!group.photo) {
    res.status(404);
    throw new Error('This group has no photo');
  }
  const ext = path.extname(group.photo).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (!storage.streamTo(group.photo, res)) return res.status(404).json({ message: 'File not found' });
});

/**
 * Invite more people to a group (owner/admin); re-invites previously declined.
 * @route POST /api/chat/groups/:id/members
 * @param {string} req.params.id - group id
 * @param {string[]} req.body.memberIds - users to add (active only)
 * @returns {{ok: true, added}}
 */
// POST /api/chat/groups/:id/members  { memberIds: [] } — invite more people (owner/admin).
const addGroupMembers = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { memberIds } = req.body;
  const group = await loadGroupForManager(req.params.id, meId);

  let ids = Array.isArray(memberIds) ? [...new Set(memberIds.map(String))] : [];
  if (ids.length === 0) {
    res.status(400);
    throw new Error('Pick at least one person to add');
  }
  const valid = await User.find({ _id: { $in: ids }, isActive: true, ...hideSuperAdminFilter(req.user) }).select('_id');

  let added = 0;
  for (const u of valid) {
    const existing = group.memberFor(u._id);
    if (!existing) {
      // brand-new invitee
      group.members.push({ user: u._id, role: 'member', status: 'invited' });
      added += 1;
    } else if (existing.status === 'declined') {
      // re-invite someone who previously declined or was removed
      existing.status = 'invited';
      existing.role = 'member';
      existing.invitedAt = new Date();
      existing.respondedAt = undefined;
      added += 1;
    }
  }
  await group.save();
  res.json({ ok: true, added });
});

/**
 * Remove a member from a group (owner/admin; only owner may remove an admin).
 * @route DELETE /api/chat/groups/:id/members/:userId
 * @param {string} req.params.id - group id
 * @param {string} req.params.userId - member to remove (not self, not the owner)
 * @returns {{ok: true}}
 */
// DELETE /api/chat/groups/:id/members/:userId — remove a member (owner/admin).
const removeGroupMember = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const targetId = req.params.userId;
  const group = await loadGroupForManager(req.params.id, meId);

  if (String(targetId) === String(meId)) {
    res.status(400);
    throw new Error('Use "Leave group" to remove yourself');
  }
  const target = group.memberFor(targetId);
  if (!target) {
    res.status(404);
    throw new Error('That person is not in this group');
  }
  if (target.role === 'owner') {
    res.status(400);
    throw new Error('The group owner cannot be removed');
  }
  // Only the owner may remove another admin.
  const meMem = group.memberFor(meId);
  if (target.role === 'admin' && meMem.role !== 'owner') {
    res.status(403);
    throw new Error('Only the owner can remove an admin');
  }
  group.members = group.members.filter((m) => String(m.user) !== String(targetId));
  await group.save();
  res.json({ ok: true });
});

/**
 * Promote/demote a group member (owner only).
 * @route PATCH /api/chat/groups/:id/members/:userId
 * @param {string} req.params.id - group id
 * @param {string} req.params.userId - target member (must be accepted, not owner)
 * @param {string} req.body.role - 'admin' or 'member'
 * @returns {{ok: true}}
 */
// PATCH /api/chat/groups/:id/members/:userId  { role: 'admin' | 'member' }
// Promote/demote a member. Owner only.
const setMemberRole = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const targetId = req.params.userId;
  const { role } = req.body;
  if (!['admin', 'member'].includes(role)) {
    res.status(400);
    throw new Error("role must be 'admin' or 'member'");
  }
  const group = await ChatGroup.findById(req.params.id);
  const meMem = group && group.memberFor(meId);
  if (!group || !meMem || meMem.role !== 'owner') {
    res.status(403);
    throw new Error('Only the group owner can change roles');
  }
  const target = group.memberFor(targetId);
  if (!target || target.status !== 'accepted') {
    res.status(404);
    throw new Error('That person is not an active member');
  }
  if (target.role === 'owner') {
    res.status(400);
    throw new Error('The owner role cannot be changed');
  }
  target.role = role;
  await group.save();
  res.json({ ok: true });
});

/**
 * Leave a group and clear it from the caller's view; reassigns ownership or
 * deletes the group when the last member leaves.
 * @route POST /api/chat/groups/:id/leave
 * @param {string} req.params.id - group id
 * @returns {{ok: true, groupDeleted?: boolean}}
 */
// POST /api/chat/groups/:id/leave — leave the group and clear it from my view.
// If the owner leaves, ownership passes to an admin (or the longest-standing
// member); if no one is left, the group and its messages are removed.
const leaveGroup = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { group, mem } = await loadGroupForMember(req.params.id, meId);
  const wasOwner = mem.role === 'owner';

  // Remove my membership and clear my view of the conversation.
  group.members = group.members.filter((m) => String(m.user) !== String(meId));
  await Message.updateMany({ group: group._id }, { $addToSet: { deletedFor: meId } });

  const remaining = group.members.filter((m) => m.status === 'accepted');
  if (remaining.length === 0) {
    // Nobody left — delete the group, its messages and photo.
    await Message.deleteMany({ group: group._id });
    if (group.photo) { try { storage.remove(group.photo); } catch { /* best effort */ } }
    await group.deleteOne();
    return res.json({ ok: true, groupDeleted: true });
  }

  if (wasOwner) {
    // Hand ownership to an existing admin, else the earliest-joined member.
    const successor = remaining.find((m) => m.role === 'admin') || remaining[0];
    successor.role = 'owner';
    group.createdBy = successor.user;
  }
  await group.save();
  res.json({ ok: true });
});

module.exports = {
  directory,
  sendRequest,
  listRequests,
  respondRequest,
  listConnections,
  getMessages,
  sendMessage,
  deleteMessage,
  clearConversation,
  adminTranscript,
  createGroup,
  listGroups,
  respondGroup,
  getGroupMessages,
  sendGroupMessage,
  clearGroup,
  getGroupInfo,
  renameGroup,
  uploadGroupPhoto,
  deleteGroupPhoto,
  getGroupPhoto,
  addGroupMembers,
  removeGroupMember,
  setMemberRole,
  leaveGroup,
};
