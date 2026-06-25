const asyncHandler = require('express-async-handler');
const DeviceToken = require('../models/DeviceToken');

// POST /api/devices/register  { token, platform?, deviceName? }
// The mobile app calls this after login once it has an Expo push token.
// Upsert on the token: if the device was previously owned by another user
// (shared phone, re-login), reassign it to the current caller.
const registerDevice = asyncHandler(async (req, res) => {
  const { token, platform = 'android', deviceName } = req.body || {};
  if (!token) {
    res.status(400);
    throw new Error('token is required');
  }

  const device = await DeviceToken.findOneAndUpdate(
    { token },
    {
      $set: {
        user: req.user._id,
        platform,
        deviceName,
        lastSeenAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.status(201).json({ ok: true, device: { id: device._id, token: device.token } });
});

// DELETE /api/devices/:token  — called on logout so the device stops receiving
// pushes meant for this account.
const unregisterDevice = asyncHandler(async (req, res) => {
  const token = req.params.token;
  await DeviceToken.deleteOne({ token, user: req.user._id });
  res.json({ ok: true });
});

module.exports = { registerDevice, unregisterDevice };
