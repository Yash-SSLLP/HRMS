const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const { ensureEmployeeProfile } = require('../services/ensureProfile');
const { PERMISSIONS, isValidPermission } = require('../config/permissions');
const { EXECUTIVE_ROLES, shouldExcludeExecutives } = require('../utils/visibility');

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
  // Roles to keep out of this result:
  //  - SuperAdmin, hidden from every non-SuperAdmin viewer;
  //  - CEO/MD, when a picker opts in (?excludeExecutives=true) and a SuperAdmin
  //    has not turned on includeExecutivesInLists.
  const excludedRoles = [];
  if (req.user.role !== 'SuperAdmin') excludedRoles.push('SuperAdmin');
  if (await shouldExcludeExecutives(req)) excludedRoles.push(...EXECUTIVE_ROLES);
  if (excludedRoles.length) {
    if (role) {
      // An explicit ?role= filter is honoured unless that role is excluded.
      if (excludedRoles.includes(role)) filter._id = { $in: [] };
    } else {
      filter.role = { $nin: excludedRoles };
    }
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

  // HR and L&D admins are also employees — give them an employee profile. CEO/MD
  // are NOT employees (no profile, no documents, not in the Employees/Users
  // lists); they appear in the Org Chart as approvers via a separate path.
  if (['HRManager', 'LDManager', 'AccountsManager'].includes(user.role)) {
    try { await ensureEmployeeProfile(user); } catch (err) { console.error('Staff profile auto-create failed:', err.message); }
  }

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

  // Promoted to HR / L&D → ensure they have an employee profile. CEO/MD are not
  // employees, so they never get one.
  if (['HRManager', 'LDManager', 'AccountsManager'].includes(user.role)) {
    try { await ensureEmployeeProfile(user); } catch (err) { console.error('Staff profile auto-create failed:', err.message); }
  }

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
  // Only SuperAdmin may change an account's active status.
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may change account status');
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
  // Only SuperAdmin may change an account's active status.
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may change account status');
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

// GET /api/admin/permissions/catalog — the capability catalog for the UI.
const getPermissionCatalog = asyncHandler(async (req, res) => {
  res.json({ permissions: PERMISSIONS });
});

// PATCH /api/admin/users/:id/permissions  (SuperAdmin only — enforced by route)
// Body: { permissions: [key,...] }. Only meaningful for HRManager accounts.
const updateUserPermissions = asyncHandler(async (req, res) => {
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) {
    res.status(400);
    throw new Error('permissions must be an array of capability keys');
  }
  const invalid = permissions.filter((p) => !isValidPermission(p));
  if (invalid.length) {
    res.status(400);
    throw new Error(`Unknown permission key(s): ${invalid.join(', ')}`);
  }
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (user.role !== 'HRManager') {
    res.status(400);
    throw new Error('Permissions apply only to HR Manager accounts.');
  }
  // De-dupe; store the explicit set (empty array = no capabilities).
  user.permissions = [...new Set(permissions)];
  await user.save();
  res.json({ user });
});

// GET /api/admin/org-settings  (SuperAdmin)
// Org-wide preferences a SuperAdmin controls. Currently: whether CEO/MD show up
// in employee-selection pickers.
const getOrgSettings = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  res.json({ includeExecutivesInLists: !!s.includeExecutivesInLists });
});

// PUT /api/admin/org-settings  (SuperAdmin)
const updateOrgSettings = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  if (req.body.includeExecutivesInLists !== undefined) {
    s.includeExecutivesInLists = !!req.body.includeExecutivesInLists;
  }
  await s.save();
  res.json({ includeExecutivesInLists: !!s.includeExecutivesInLists });
});

module.exports = {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  deleteUser,
  getPermissionCatalog,
  updateUserPermissions,
  getOrgSettings,
  updateOrgSettings,
};
