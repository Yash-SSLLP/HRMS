const asyncHandler = require('express-async-handler');
const path = require('path');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const storage = require('../services/storage');

// POST /api/auth/signup  (public — creates Employee accounts only)
// Privileged accounts (HRManager/SuperAdmin) must be created via /api/admin/users.
const signup = asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, phone } = req.body;

  if (!email || !password || !firstName || !lastName) {
    res.status(400);
    throw new Error('email, password, firstName, lastName are required');
  }

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) {
    res.status(409);
    throw new Error('Email already registered');
  }

  const user = await User.create({
    email,
    password,
    firstName,
    lastName,
    phone,
    role: 'Employee',
  });

  res.status(201).json({
    user: user.toJSON(),
    token: generateToken(user._id, user.role, user.tokenVersion),
  });
});

// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400);
    throw new Error('email and password are required');
  }

  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    res.status(401);
    throw new Error('Invalid credentials');
  }

  if (!user.isActive) {
    res.status(403);
    throw new Error('Account is deactivated');
  }

  user.lastLoginAt = new Date();
  await user.save();

  res.json({
    user: user.toJSON(),
    token: generateToken(user._id, user.role, user.tokenVersion),
  });
});

// GET /api/auth/me  (protected)
const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toJSON() });
});

// PATCH /api/auth/me/credentials  (protected, SuperAdmin only)
// Self-service email / password change. By policy, only SuperAdmin may change
// their own credentials directly — everyone else must raise a change request
// that their admin approves.
const updateMyCredentials = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may change their own credentials. Please raise a change request instead.');
  }

  const { currentPassword, email, newPassword } = req.body;
  if (!currentPassword) {
    res.status(400);
    throw new Error('Your current password is required to make changes');
  }
  if (!email && !newPassword) {
    res.status(400);
    throw new Error('Provide a new email and/or a new password');
  }

  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.comparePassword(currentPassword))) {
    res.status(401);
    throw new Error('Current password is incorrect');
  }

  if (email && email.toLowerCase() !== user.email) {
    const exists = await User.findOne({ email: email.toLowerCase(), _id: { $ne: user._id } });
    if (exists) {
      res.status(409);
      throw new Error('That email is already in use');
    }
    user.email = email.toLowerCase();
  }
  if (newPassword) user.password = newPassword; // pre-save hook re-hashes

  await user.save();
  res.json({ user: user.toJSON() });
});

// POST /api/auth/me/avatar  (protected, multipart: photo)
// Self-service profile photo upload. Replaces any existing photo on disk.
const uploadMyAvatar = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('A photo is required');
  }
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  const { storagePath } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'avatars',
    ownerId: user._id,
    originalName: req.file.originalname || 'avatar.jpg',
  });
  const previous = user.photo;
  user.photo = storagePath;
  await user.save();
  if (previous && previous !== storagePath) {
    try { storage.remove(previous); } catch { /* best effort */ }
  }
  res.json({ user: user.toJSON() });
});

// DELETE /api/auth/me/avatar  (protected) — remove my profile photo.
const deleteMyAvatar = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user.photo) {
    try { storage.remove(user.photo); } catch { /* best effort */ }
    user.photo = null;
    await user.save();
  }
  res.json({ user: user.toJSON() });
});

// GET /api/auth/users/:id/avatar  (protected) — stream any active user's photo.
// Any authenticated user may view avatars (used across chat, directory, etc.).
const getUserAvatar = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('photo isActive');
  if (!user || !user.photo) {
    res.status(404);
    throw new Error('No photo for this user');
  }
  const ext = path.extname(user.photo).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // The DB row can point at a file that no longer exists on disk — stream
  // safely and 404 rather than crashing the server on an ENOENT stream error.
  if (!storage.streamTo(user.photo, res)) {
    res.status(404);
    throw new Error('No photo for this user');
  }
});

// POST /api/auth/me/banner  (protected, multipart: photo) — cover/banner photo.
const uploadMyBanner = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('A photo is required');
  }
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  const { storagePath } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'banners',
    ownerId: user._id,
    originalName: req.file.originalname || 'banner.jpg',
  });
  const previous = user.banner;
  user.banner = storagePath;
  await user.save();
  if (previous && previous !== storagePath) {
    try { storage.remove(previous); } catch { /* best effort */ }
  }
  res.json({ user: user.toJSON() });
});

// DELETE /api/auth/me/banner  (protected) — remove my banner photo.
const deleteMyBanner = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user.banner) {
    try { storage.remove(user.banner); } catch { /* best effort */ }
    user.banner = null;
    await user.save();
  }
  res.json({ user: user.toJSON() });
});

// GET /api/auth/users/:id/banner  (protected) — stream any active user's banner.
const getUserBanner = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('banner isActive');
  if (!user || !user.banner) {
    res.status(404);
    throw new Error('No banner for this user');
  }
  const ext = path.extname(user.banner).toLowerCase();
  const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (!storage.streamTo(user.banner, res)) {
    res.status(404);
    throw new Error('No banner for this user');
  }
});

module.exports = {
  signup, login, me, updateMyCredentials,
  uploadMyAvatar, deleteMyAvatar, getUserAvatar,
  uploadMyBanner, deleteMyBanner, getUserBanner,
};
