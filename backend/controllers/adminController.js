const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { ROLES } = require('../models/User');

// GET /api/admin/users?role=&active=&q=
const listUsers = asyncHandler(async (req, res) => {
  const { role, active, q } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (active === 'true') filter.isActive = true;
  if (active === 'false') filter.isActive = false;
  if (q) {
    const re = new RegExp(q, 'i');
    filter.$or = [{ firstName: re }, { lastName: re }, { email: re }];
  }
  // Hide SuperAdmin accounts from non-SuperAdmin viewers.
  if (req.user.role !== 'SuperAdmin') {
    if (!role) filter.role = { $ne: 'SuperAdmin' };
    else if (role === 'SuperAdmin') filter._id = { $in: [] };
  }
  const users = await User.find(filter).sort({ createdAt: -1 });
  res.json({ count: users.length, users });
});

// GET /api/admin/users/:id
const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  res.json({ user });
});

// POST /api/admin/users
const createUser = asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, role, phone, isActive } = req.body;

  if (!email || !password || !firstName || !lastName || !role) {
    res.status(400);
    throw new Error('email, password, firstName, lastName, role are required');
  }
  if (!ROLES.includes(role)) {
    res.status(400);
    throw new Error(`role must be one of ${ROLES.join(', ')}`);
  }

  // Only SuperAdmin may create accounts with admin-level roles
  // (SuperAdmin or HRManager). HRManagers may only create Employees.
  if (role !== 'Employee' && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may create admin accounts. You can only create Employee accounts.');
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
    role,
    phone,
    isActive: isActive !== undefined ? isActive : true,
  });

  res.status(201).json({ user });
});

// PUT /api/admin/users/:id
const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // HRManagers can only touch Employee accounts. They cannot edit other
  // admins, and they cannot promote anyone to/from an admin role.
  if (req.user.role !== 'SuperAdmin' && user.role !== 'Employee') {
    res.status(403);
    throw new Error('Only SuperAdmin may modify admin accounts');
  }

  const { firstName, lastName, role, phone, isActive, password } = req.body;

  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      res.status(400);
      throw new Error(`role must be one of ${ROLES.join(', ')}`);
    }
    if (role !== 'Employee' && req.user.role !== 'SuperAdmin') {
      res.status(403);
      throw new Error('Only SuperAdmin may assign admin roles');
    }
    user.role = role;
  }

  if (firstName !== undefined) user.firstName = firstName;
  if (lastName !== undefined) user.lastName = lastName;
  if (phone !== undefined) user.phone = phone;
  if (isActive !== undefined) user.isActive = isActive;
  if (password) user.password = password; // pre-save hook re-hashes

  await user.save();
  res.json({ user });
});

// PATCH /api/admin/users/:id/deactivate
const deactivateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user._id.equals(req.user._id)) {
    res.status(400);
    throw new Error('You cannot deactivate your own account');
  }
  if (req.user.role !== 'SuperAdmin' && user.role !== 'Employee') {
    res.status(403);
    throw new Error('Only SuperAdmin may deactivate admin accounts');
  }
  user.isActive = false;
  await user.save();
  res.json({ user });
});

// PATCH /api/admin/users/:id/activate
const activateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (req.user.role !== 'SuperAdmin' && user.role !== 'Employee') {
    res.status(403);
    throw new Error('Only SuperAdmin may activate admin accounts');
  }
  user.isActive = true;
  await user.save();
  res.json({ user });
});

// DELETE /api/admin/users/:id  (SuperAdmin only)
const deleteUser = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may permanently delete users');
  }
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user._id.equals(req.user._id)) {
    res.status(400);
    throw new Error('You cannot delete your own account');
  }
  await user.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  deleteUser,
};
