const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const generateToken = require('../utils/generateToken');

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
    token: generateToken(user._id, user.role),
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
    token: generateToken(user._id, user.role),
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

module.exports = { signup, login, me, updateMyCredentials };
