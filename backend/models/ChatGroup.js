const mongoose = require('mongoose');

// A group chat/conversation in the internal messaging module. Holds its members
// (with roles + invite status embedded) and metadata; messages live in Message.
const MEMBER_STATUS = ['invited', 'accepted', 'declined']; // invite lifecycle for a group member

// A member of a group chat. An invitee must `accept` before they join and can
// see the group's messages. `lastReadAt` drives the per-member unread count.
const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // owner  = group creator; full control, cannot be removed, one per group
    // admin  = can add/remove members, rename, change photo
    // member = can read/send messages and leave
    role: { type: String, enum: ['owner', 'admin', 'member'], default: 'member' },
    status: { type: String, enum: MEMBER_STATUS, default: 'invited' },
    invitedAt: { type: Date, default: Date.now },
    respondedAt: { type: Date },
    lastReadAt: { type: Date },
  },
  { _id: false }
);

const chatGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    members: { type: [memberSchema], default: [] },
    // Group photo, stored as a path relative to UPLOAD_DIR (served via the
    // /api/chat/groups/:id/photo endpoint). Null when the group has no photo.
    photo: { type: String, default: null },
  },
  { timestamps: true }
);

chatGroupSchema.index({ 'members.user': 1 });

// Convenience: the accepted member sub-doc for a given user (or null).
chatGroupSchema.methods.memberFor = function memberFor(userId) {
  // Works whether members.user is populated (a doc) or a raw ObjectId.
  return this.members.find((m) => String(m.user?._id || m.user) === String(userId)) || null;
};

// Owner or admin — the roles allowed to manage the group (members, name, photo).
chatGroupSchema.methods.isManager = function isManager(userId) {
  const mem = this.memberFor(userId);
  return Boolean(mem && mem.status === 'accepted' && (mem.role === 'owner' || mem.role === 'admin'));
};

module.exports = mongoose.model('ChatGroup', chatGroupSchema);
module.exports.MEMBER_STATUS = MEMBER_STATUS;
