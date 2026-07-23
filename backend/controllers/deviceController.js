/**
 * Device controller — registers/unregisters Expo push tokens (DeviceToken) so the
 * mobile app can receive push notifications, keyed by the device's push token.
 */
const asyncHandler = require('express-async-handler');
const DeviceToken = require('../models/DeviceToken');

/**
 * Register (or re-own) an Expo push token for the current user.
 * @route POST /api/devices/register
 * @param {string} req.body.token - Expo push token (required)
 * @param {string} [req.body.platform='android']
 * @param {string} [req.body.deviceName]
 * @returns {{ok: boolean, device: {id: string, token: string}}} (201)
 */
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

/**
 * Unregister a push token for the current user (called on logout).
 * @route DELETE /api/devices/:token
 * @param {string} req.params.token - the Expo push token to remove
 * @returns {{ok: boolean}}
 */
// DELETE /api/devices/:token  — called on logout so the device stops receiving
// pushes meant for this account.
const unregisterDevice = asyncHandler(async (req, res) => {
  const token = req.params.token;
  await DeviceToken.deleteOne({ token, user: req.user._id });
  res.json({ ok: true });
});

module.exports = { registerDevice, unregisterDevice };
