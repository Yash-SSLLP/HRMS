/**
 * Auth controller — signup/login/logout (issuing JWTs), the current-user endpoint,
 * SuperAdmin self-service credential changes, and self-service avatar/banner photo
 * upload/delete plus streaming any user's avatar/banner. Manages User accounts.
 */
const asyncHandler = require('express-async-handler');
const path = require('path');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const storage = require('../services/storage');
const { resolveLoginUser } = require('../utils/loginIdentity');

/**
 * Public signup — always creates an Employee-role account and returns a JWT.
 * @route POST /api/auth/signup  (PUBLIC)
 * @param {string} req.body.email - required, unique
 * @param {string} req.body.password - required
 * @param {string} req.body.firstName - required
 * @param {string} req.body.lastName - required
 * @param {string} [req.body.phone]
 * @returns {{user: Object, token: string}} (201); 409 if email exists
 */
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

/**
 * Log in with an employee code, role alias or email, plus the password.
 *
 * The identifier arrives as `identifier`; `email` is still read as a fallback so
 * an older mobile build that has not been updated yet keeps working. See
 * utils/loginIdentity for what an identifier may be and how it is matched.
 *
 * @route POST /api/auth/login  (PUBLIC)
 * @param {string} req.body.identifier - employee code ("SSL 120"), role alias
 *   ("admin" / "CEO" / "MD") or email address. Case-insensitive.
 * @param {string} [req.body.email] - legacy alias for `identifier`.
 * @param {string} req.body.password - required
 * @returns {{user: Object, token: string}}; 401 invalid, 403 deactivated
 * @sideeffect stamps lastLoginAt
 */
// POST /api/auth/login
const login = asyncHandler(async (req, res) => {
  const { identifier, email, password } = req.body;
  const typed = identifier || email;
  if (!typed || !password) {
    res.status(400);
    throw new Error('Employee code and password are required');
  }

  const { user, ambiguous, reason } = await resolveLoginUser(typed);
  // An identifier matching several accounts is refused outright rather than
  // signing someone into whichever record came back first. This is the only
  // case that gets a specific message — it tells the person how to proceed and
  // reveals nothing about whether any particular account exists.
  if (ambiguous) {
    res.status(409);
    throw new Error(reason);
  }
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

  // Session trace on the server console — one line in, one line out (see logout).
  console.log(`${user.firstName} : Logged in`);

  res.json({
    user: user.toJSON(),
    token: generateToken(user._id, user.role, user.tokenVersion),
  });
});

/**
 * Sign-out ping. The JWT is stateless — the client discards it and that ends the
 * session — so this exists purely to close the console trace that login opens.
 * @route POST /api/auth/logout  (protected)
 * @returns {{ok: true}}
 */
// POST /api/auth/logout  (protected)
const logout = asyncHandler(async (req, res) => {
  console.log(`${req.user.firstName} : Logged out`);
  res.json({ ok: true });
});

/**
 * Return the authenticated user plus the org-wide feature switches every client
 * needs to render itself.
 *
 * `features` is deliberately here rather than on /admin/org-settings, which is
 * SuperAdmin-only — every portal has to know whether chat exists, and this is
 * the call each of them already makes on load.
 * @route GET /api/auth/me  (protected)
 * @returns {{user: Object, features: {chatEnabled: boolean}}}
 */
// GET /api/auth/me  (protected)
const me = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const settings = await Setting.getSettings().catch(() => ({}));
  res.json({
    user: req.user.toJSON(),
    features: { chatEnabled: !!settings.chatEnabled },
  });
});

/**
 * SuperAdmin self-service change of their own email and/or password.
 * @route PATCH /api/auth/me/credentials  (protected)
 * @param {string} req.body.currentPassword - required for verification
 * @param {string} [req.body.email] - new login email (SuperAdmin only, must be unique)
 * @param {string} [req.body.newPassword] - new password (any signed-in user)
 * @returns {{user: Object}}; 401 wrong password, 403 non-SuperAdmin changing email,
 *   409 email in use
 */
// PATCH /api/auth/me/credentials  (protected)
// Self-service credential change. ANY signed-in user may change their own
// PASSWORD here: it is not an administrative act, and the guard that matters is
// the current-password check below, which an attacker holding a stolen session
// cannot satisfy. Routing it through an approval instead used to mean the new
// password sat in a ChangeRequest document in plain text until somebody clicked
// approve — the workflow was the exposure, not the protection.
//
// The login EMAIL is different and stays SuperAdmin-only: it decides how the
// account signs in, is unique-checked across accounts, and is an identity change
// rather than a secret the owner already knows.
const updateMyCredentials = asyncHandler(async (req, res) => {
  const { currentPassword, email, newPassword } = req.body;

  if (email && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Your login email is changed by HR. You can change your password here.');
  }
  if (!currentPassword) {
    res.status(400);
    throw new Error('Your current password is required to make changes');
  }
  if (!email && !newPassword) {
    res.status(400);
    // Don't offer the email half to somebody who cannot use it.
    throw new Error(req.user.role === 'SuperAdmin'
      ? 'Provide a new email and/or a new password'
      : 'Enter the new password you want.');
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
  if (newPassword) {
    user.password = newPassword; // pre-save hook re-hashes
    // Whatever an admin set is now replaced by something only this person knows,
    // which is exactly what the flag was waiting for. Cleared HERE rather than in
    // the model hook because the hook cannot tell an admin reset (which SETS the
    // flag) from the owner's own change (which clears it).
    user.mustChangePassword = false;
  }

  await user.save();
  res.json({ user: user.toJSON() });
});

/**
 * Upload the caller's profile photo, replacing any existing one.
 * @route POST /api/auth/me/avatar  (protected, multipart field: photo)
 * @param {File} req.file - the image (required)
 * @returns {{user: Object}}
 * @sideeffect removes the previously stored avatar
 */
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
  const { storagePath } = await storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'avatars',
    ownerId: user._id,
    originalName: req.file.originalname || 'avatar.jpg',
  });
  const previous = user.photo;
  user.photo = storagePath;
  await user.save();
  if (previous && previous !== storagePath) {
    try { await storage.remove(previous); } catch { /* best effort */ }
  }
  res.json({ user: user.toJSON() });
});

/**
 * Remove the caller's profile photo.
 * @route DELETE /api/auth/me/avatar  (protected)
 * @returns {{user: Object}}
 */
// DELETE /api/auth/me/avatar  (protected) — remove my profile photo.
const deleteMyAvatar = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user.photo) {
    try { await storage.remove(user.photo); } catch { /* best effort */ }
    user.photo = null;
    await user.save();
  }
  res.json({ user: user.toJSON() });
});

/**
 * Stream a user's avatar image (any authenticated viewer).
 * @route GET /api/auth/users/:id/avatar  (protected)
 * @param {string} req.params.id - user id
 * @returns {binary} the image, or 404 when absent/missing on disk
 */
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
  if (!(await storage.streamTo(user.photo, res))) {
    res.status(404);
    throw new Error('No photo for this user');
  }
});

/**
 * Upload the caller's cover/banner photo, replacing any existing one.
 * @route POST /api/auth/me/banner  (protected, multipart field: photo)
 * @param {File} req.file - the image (required)
 * @returns {{user: Object}}
 * @sideeffect removes the previously stored banner
 */
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
  const { storagePath } = await storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'banners',
    ownerId: user._id,
    originalName: req.file.originalname || 'banner.jpg',
  });
  const previous = user.banner;
  user.banner = storagePath;
  await user.save();
  if (previous && previous !== storagePath) {
    try { await storage.remove(previous); } catch { /* best effort */ }
  }
  res.json({ user: user.toJSON() });
});

/**
 * Remove the caller's banner photo.
 * @route DELETE /api/auth/me/banner  (protected)
 * @returns {{user: Object}}
 */
// DELETE /api/auth/me/banner  (protected) — remove my banner photo.
const deleteMyBanner = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user.banner) {
    try { await storage.remove(user.banner); } catch { /* best effort */ }
    user.banner = null;
    await user.save();
  }
  res.json({ user: user.toJSON() });
});

/**
 * Stream a user's banner image (any authenticated viewer).
 * @route GET /api/auth/users/:id/banner  (protected)
 * @param {string} req.params.id - user id
 * @returns {binary} the image, or 404 when absent/missing on disk
 */
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
  if (!(await storage.streamTo(user.banner, res))) {
    res.status(404);
    throw new Error('No banner for this user');
  }
});

module.exports = {
  signup, login, logout, me, updateMyCredentials,
  uploadMyAvatar, deleteMyAvatar, getUserAvatar,
  uploadMyBanner, deleteMyBanner, getUserBanner,
};
