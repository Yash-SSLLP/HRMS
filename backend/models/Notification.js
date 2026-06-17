const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'general' }, // e.g. 'event'
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    // A logical target the frontend resolves to the right portal, e.g. 'calendar'.
    link: { type: String, trim: true },
    readAt: { type: Date },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
