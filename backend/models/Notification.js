const mongoose = require('mongoose');

// An in-app notification delivered to a single user's bell/feed. Created by many
// modules (events, approvals, social) and scoped per portal via `audience`.
const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // WHO it came from, when that is a person rather than the system. Most
    // notifications have no sender — an event reminder is from nobody — so it is
    // optional and every existing document simply has none.
    //
    // It exists because a celebration wish could not be REPLIED to: the wisher's
    // name lived only inside the title string ("Rahul sent you a birthday wish"),
    // which is enough to read and useless to act on. Anything that wants to let a
    // recipient answer needs the id, not the sentence.
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
    // When the recipient thanked the sender for this one. Wish-specific, and it
    // sits here for the same reason `dismissedAt` does — the wish IS a
    // notification, and there is no other document to hang it on. It does two
    // jobs: the card shows "Thanks sent" instead of offering the button again,
    // and the server refuses a second thanks rather than letting one wish
    // generate an unbounded number of pings.
    thankedAt: { type: Date },
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
