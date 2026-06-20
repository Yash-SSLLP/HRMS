const asyncHandler = require('express-async-handler');
const Connection = require('../models/Connection');
const Message = require('../models/Message');
const User = require('../models/User');

const USER_FIELDS = 'firstName lastName email role';

function publicUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
    email: u.email,
    role: u.role,
  };
}

// Resolve the "other" participant id of a connection relative to the caller.
function otherParty(conn, meId) {
  return conn.requester.equals(meId) ? conn.recipient : conn.requester;
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

// GET /api/chat/directory  — active users (except self) with the caller's
// connection status to each. Reused by the complaints target picker.
const directory = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const users = await User.find({ isActive: true, _id: { $ne: meId } })
    .select(USER_FIELDS)
    .sort({ firstName: 1, lastName: 1 });

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

  const pairKey = Connection.buildPairKey(meId, recipientId);
  let conn = await Connection.findOne({ pairKey });

  if (conn) {
    if (conn.status === 'accepted') {
      res.status(409);
      throw new Error('You are already connected');
    }
    if (conn.status === 'pending') {
      res.status(409);
      throw new Error('A request is already pending');
    }
    // Previously declined — revive as a fresh request from the caller.
    conn.requester = meId;
    conn.recipient = recipientId;
    conn.status = 'pending';
    await conn.save();
  } else {
    conn = await Connection.create({ requester: meId, recipient: recipientId });
  }

  res.status(201).json({ connection: conn });
});

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

  const out = await Promise.all(
    conns.map(async (c) => {
      const other = c.requester._id.equals(meId) ? c.recipient : c.requester;
      const lastMessage = await Message.findOne({ connection: c._id }).sort({ createdAt: -1 });
      const unread = await Message.countDocuments({
        connection: c._id,
        sender: { $ne: meId },
        readAt: null,
      });
      return {
        connectionId: c._id,
        person: publicUser(other),
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

  const messages = await Message.find({ connection: req.params.connectionId })
    .sort({ createdAt: 1 })
    .lean();

  res.json({
    messages: messages.map((m) => ({
      _id: m._id,
      body: m.body,
      createdAt: m.createdAt,
      mine: String(m.sender) === String(meId),
      status: messageStatus(m),
    })),
  });
});

// POST /api/chat/messages  { connectionId, body }
const sendMessage = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { connectionId, body } = req.body;
  if (!connectionId || !body || !body.trim()) {
    res.status(400);
    throw new Error('connectionId and body are required');
  }
  await loadParticipantConnection(connectionId, meId);

  const message = await Message.create({ connection: connectionId, sender: meId, body: body.trim() });
  res.status(201).json({
    message: { _id: message._id, body: message.body, createdAt: message.createdAt, mine: true, status: 'sent' },
  });
});

module.exports = {
  directory,
  sendRequest,
  listRequests,
  respondRequest,
  listConnections,
  getMessages,
  sendMessage,
};
