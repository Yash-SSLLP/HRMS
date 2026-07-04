const mongoose = require('mongoose');

// Categories an announcement can be filed under.
const ANNOUNCEMENT_CATEGORIES = ['General', 'Policy', 'Event', 'Holiday', 'Benefits', 'Urgent'];

// A company news-feed item posted by HR/SuperAdmin. Like events, creating one
// fans out a notification to every other active user.
const announcementSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ANNOUNCEMENT_CATEGORIES,
      default: 'General',
      index: true,
    },
    pinned: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Users who dismissed this from their overview banner. It still shows in the
    // full Announcements feed — dismissing only hides it from the front page.
    dismissedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Announcement', announcementSchema);
module.exports.ANNOUNCEMENT_CATEGORIES = ANNOUNCEMENT_CATEGORIES;
