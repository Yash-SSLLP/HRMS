const mongoose = require('mongoose');

// An in-app notification delivered to a single user's bell/feed. Created by many
// modules (events, approvals, social) and scoped per portal via `audience`.
const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'general' }, // e.g. 'event'
    // Which portal this notification belongs in for a dual-role user (e.g. an
    // HRManager who is also an employee): 'admin' shows only in the Admin portal,
    // 'employee' only in My Portal, 'all' in both (personal/social items).
    audience: { type: String, enum: ['admin', 'employee', 'all'], default: 'all', index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    // A logical target the frontend resolves to the right portal, e.g. 'calendar'.
    link: { type: String, trim: true },
    readAt: { type: Date },
    // Cleared from the user's view WITHOUT deleting the record — they chose to
    // dismiss it. Used by the dashboard "Wishes for you" card, whose whole point
    // is to be a transient greeting rather than a permanent list.
    dismissedAt: { type: Date },
    // When this notification stops being worth showing on a dashboard card.
    // A celebration wish expires two days after the occasion it celebrates, so
    // last month's birthday greetings do not pile up on someone's home screen.
    // Null / absent = never expires (every other notification type today).
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
