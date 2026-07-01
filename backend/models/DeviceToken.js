const mongoose = require('mongoose');

// One row per (user, device). Stores the native FCM/APNs device token the
// mobile app registers after login. The backend delivers pushes to these tokens
// directly through Firebase Cloud Messaging (see services/push.js).
const deviceTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // FCM (Android) / APNs (iOS) registration token. Unique so the same physical
    // device re-registering just updates its owner/timestamp.
    token: { type: String, required: true, unique: true, trim: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
    // Free-form device label for debugging ("Pixel 7", "SM-G991B", …).
    deviceName: { type: String, trim: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

deviceTokenSchema.index({ user: 1, token: 1 });

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
