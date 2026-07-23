const mongoose = require('mongoose');

// A single chat message in the internal messaging module. Belongs to either a
// 1:1 Connection or a group ChatGroup (exactly one), and is never hard-deleted.
const messageSchema = new mongoose.Schema(
  {
    // A message belongs to either a 1:1 connection OR a group (exactly one).
    connection: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Connection',
      required: function requiredWhenNoGroup() { return !this.group; },
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChatGroup',
    },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    deliveredAt: { type: Date },
    readAt: { type: Date },
    // Users who have hidden (soft-deleted) this message from their own view.
    // The document is never removed — SuperAdmin can still extract it.
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

messageSchema.index({ connection: 1, createdAt: 1 });
messageSchema.index({ group: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
