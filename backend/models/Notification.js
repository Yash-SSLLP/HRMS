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
    /**
     * WHICH OCCASION a celebration wish was for. Wish-specific, and it sits here
     * for the same reason `thankedAt` does — the wish IS a notification, there
     * is no other document to hang it on.
     *
     * WHY IT IS NEEDED AT ALL. The Wish button used to be hidden by component
     * state alone, so it came back on every page load and a colleague could be
     * wished the same birthday over and over. Answering "have I already wished
     * them?" needs the wish to say who it was for, which occasion, and which
     * DAY that occasion falls on — a title reading "🎂 X sent you a birthday
     * wish" can be shown to a person but cannot be queried.
     *
     * `occasionOn` is the IST calendar date of the occasion (not of the wish):
     * it is the same value for a greeting sent five days early and one sent on
     * the day, which is exactly what makes them comparable. `onTheDay` splits
     * those two into the module's two wishing windows — see sendWish.
     *
     * Absent on every notification that is not a wish, and on wishes sent before
     * this existed; both read as "no record", which is the honest answer.
     */
    celebration: {
      kind: { type: String },        // 'birthday' | 'anniversary' | 'marriage'
      occasionOn: { type: String },  // 'YYYY-MM-DD', IST
      onTheDay: { type: Boolean },   // sent on or after the day, rather than early
    },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });
// "Which of these people have I already wished, for this occasion?" — one query
// per dashboard load, so it is worth an index.
notificationSchema.index({ sender: 1, 'celebration.occasionOn': 1 }, { sparse: true });

module.exports = mongoose.model('Notification', notificationSchema);
