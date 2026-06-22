const mongoose = require('mongoose');

const MEMBER_STATUS = ['invited', 'accepted', 'declined'];

// A member of a group chat. An invitee must `accept` before they join and can
// see the group's messages. `lastReadAt` drives the per-member unread count.
const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['owner', 'member'], default: 'member' },
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
  },
  { timestamps: true }
);

chatGroupSchema.index({ 'members.user': 1 });

// Convenience: the accepted member sub-doc for a given user (or null).
chatGroupSchema.methods.memberFor = function memberFor(userId) {
  // Works whether members.user is populated (a doc) or a raw ObjectId.
  return this.members.find((m) => String(m.user?._id || m.user) === String(userId)) || null;
};

module.exports = mongoose.model('ChatGroup', chatGroupSchema);
module.exports.MEMBER_STATUS = MEMBER_STATUS;
