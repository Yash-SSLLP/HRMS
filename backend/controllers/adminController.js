/**
 * Admin controller — user-account administration (User model). SuperAdmin manages
 * all accounts and roles; HRManager is limited to Employee accounts. Covers user
 * CRUD, activate/deactivate, per-HRManager permission grants, a standalone
 * cashbook-access flag, and org-wide settings (executive visibility in pickers).
 * Creating/promoting HR/L&D/Accounts staff auto-provisions an EmployeeProfile.
 */
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const { ensureEmployeeProfile } = require('../services/ensureProfile');
const { PERMISSIONS, isValidPermission } = require('../config/permissions');
const { EXECUTIVE_ROLES, shouldExcludeExecutives } = require('../utils/visibility');
const { enqueueMail } = require('../services/email');
const COMPANY = require('../config/company');

const APP_BASE_URL = () => (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');

/**
 * Tell someone their sign-in email was changed for them.
 *
 * Sent to the NEW address only, and deliberately without naming the old one:
 * if HR mistypes the address this lands in a stranger's inbox, and it should
 * not carry the employee's previous address with it. Queued, so a mail outage
 * can never undo a change HR has already made.
 *
 * @param {object} user - the User, already saved with the new address
 * @param {object} actor - the admin who made the change
 */
function notifyEmailChanged(user, actor) {
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'there';
  return enqueueMail({
    to: user.email,
    subject: `Your sign-in email has been updated - ${COMPANY.name}`,
    text:
      `Dear ${name},\n\n` +
      `Your ${COMPANY.name} HRMS sign-in email has been updated by HR. From now on, ` +
      `please sign in with this address:\n\n  ${user.email}\n\n` +
      `Your password has not changed.\n\n` +
      `Sign in here:\n${APP_BASE_URL()}\n\n` +
      `If you were not expecting this, please contact HR straight away.\n\n` +
      `Regards,\n${actor?.fullName || 'HR Team'}\n${COMPANY.name}`,
    replyTo: actor?.email,
  }, { type: 'user-email-change', id: user._id });
}

/**
 * List user accounts with optional role/active/text filters.
 * @route GET /api/admin/users?role=&active=&q=
 * @param {string} [req.query.role] / [req.query.active] / [req.query.q]
 * @returns {{count: number, users: Object[]}} (SuperAdmin, and optionally CEO/MD, hidden per viewer)
 */
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

  // Attach the work-from-home grant, which lives on the employee profile. One
  // extra query for the whole page rather than a lookup per row; users without a
  // profile (CEO/MD) simply come back false.
  const wfhByUser = new Map(
    (await EmployeeProfile.find({ user: { $in: users.map((u) => u._id) } })
      .select('user wfhAllowed').lean())
      .map((p) => [String(p.user), !!p.wfhAllowed])
  );
  const out = users.map((u) => ({
    ...u.toJSON(),
    wfhAllowed: wfhByUser.get(String(u._id)) || false,
    hasProfile: wfhByUser.has(String(u._id)),
  }));

  res.json({ count: out.length, users: out });
});

/**
 * Get a single user account by id.
 * @route GET /api/admin/users/:id
 * @param {string} req.params.id - user id
 * @returns {{user: Object}}
 */
// GET /api/admin/users/:id
const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  res.json({ user });
});

/**
 * Create a user account (admin roles are SuperAdmin-only).
 * @route POST /api/admin/users
 * @param {string} req.body.email / password / firstName / lastName / role - required
 * @param {string} [req.body.phone]
 * @param {boolean} [req.body.isActive=true]
 * @returns {{user: Object}} (201); 409 if email exists
 * @sideeffect auto-creates an EmployeeProfile for HR/L&D/Accounts staff roles
 */
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

/**
 * Update a user account (HRManager limited to Employee accounts; role changes to
 * admin roles are SuperAdmin-only).
 * @route PUT /api/admin/users/:id
 * @param {string} req.params.id - user id
 * @param {Object} req.body - firstName/lastName/role/phone/isActive/password/email
 * @throws 409 when the email is already used by another account
 * @returns {{user: Object}}
 * @sideeffect auto-creates an EmployeeProfile when promoted to HR/L&D/Accounts staff
 */
// PUT /api/admin/users/:id
const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // Permission gate: HRManagers can only touch Employee accounts. They cannot edit other
  // admins, and they cannot promote anyone to/from an admin role.
  if (req.user.role !== 'SuperAdmin' && user.role !== 'Employee') {
    res.status(403);
    throw new Error('Only SuperAdmin may modify admin accounts');
  }

  const { firstName, lastName, role, phone, isActive, password, email } = req.body;

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

  // Email is the login identity, so it is changed deliberately and checked for
  // a clash first — a duplicate would otherwise surface as a raw index error,
  // and the account would be left unable to sign in under either address.
  let emailChanged = false;
  if (email !== undefined && String(email).toLowerCase().trim() !== user.email) {
    const next = String(email).toLowerCase().trim();
    if (!next) {
      res.status(400);
      throw new Error('Email cannot be empty');
    }
    const clash = await User.findOne({ email: next, _id: { $ne: user._id } });
    if (clash) {
      res.status(409);
      throw new Error('That email is already in use by another account');
    }
    user.email = next;
    emailChanged = true;
  }

  if (firstName !== undefined) user.firstName = firstName;
  if (lastName !== undefined) user.lastName = lastName;
  if (phone !== undefined) user.phone = phone;
  if (isActive !== undefined) user.isActive = isActive;
  if (password) user.password = password; // pre-save hook re-hashes

  await user.save();

  // Best-effort: the address is already changed, so a mail failure must not
  // fail the request or roll anything back.
  if (emailChanged) {
    notifyEmailChanged(user, req.user).catch((err) => {
      console.error('[admin] Could not queue the email-change notice:', err.message);
    });
  }

  // Promoted to HR / L&D → ensure they have an employee profile. CEO/MD are not
  // employees, so they never get one.
  if (['HRManager', 'LDManager', 'AccountsManager'].includes(user.role)) {
    try { await ensureEmployeeProfile(user); } catch (err) { console.error('Staff profile auto-create failed:', err.message); }
  }

  res.json({ user });
});

/**
 * Deactivate a user account (SuperAdmin only; cannot deactivate self).
 * @route PATCH /api/admin/users/:id/deactivate
 * @param {string} req.params.id - user id
 * @returns {{user: Object}}
 */
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

/**
 * Reactivate a user account (SuperAdmin only).
 * @route PATCH /api/admin/users/:id/activate
 * @param {string} req.params.id - user id
 * @returns {{user: Object}}
 */
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

/**
 * Permanently delete a user account (SuperAdmin only; cannot delete self).
 * @route DELETE /api/admin/users/:id
 * @param {string} req.params.id - user id
 * @returns {{id: string, deleted: boolean}}
 */
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

/**
 * Return the capability/permission catalog for building the admin UI.
 * @route GET /api/admin/permissions/catalog
 * @returns {{permissions: Object}}
 */
// GET /api/admin/permissions/catalog — the capability catalog for the UI.
const getPermissionCatalog = asyncHandler(async (req, res) => {
  res.json({ permissions: PERMISSIONS });
});

/**
 * Set an HRManager's explicit permission set.
 * @route PATCH /api/admin/users/:id/permissions  (SuperAdmin only)
 * @param {string} req.params.id - user id (must be an HRManager)
 * @param {string[]} req.body.permissions - valid capability keys (deduped)
 * @returns {{user: Object}}
 */
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

/**
 * Grant or revoke standalone Cashbook access for any user (role-independent flag).
 * @route PATCH /api/admin/users/:id/cashbook-access  (SuperAdmin)
 * @param {string} req.params.id - user id
 * @param {boolean} req.body.enabled
 * @returns {{id, cashbookAccess}}
 */
// PATCH /api/admin/users/:id/cashbook-access  { enabled }  (SuperAdmin)
// Grant or revoke Cashbook access for ANY user/employee — a standalone flag that
// works regardless of role, so no separate finance login is needed.
const setCashbookAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  user.cashbookAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, cashbookAccess: user.cashbookAccess });
});

/**
 * Grant or revoke work-from-home for one employee.
 * @route PATCH /api/admin/users/:id/wfh-access  (SuperAdmin)
 * @param {string} req.params.id - user id (resolved to their employee profile)
 * @param {boolean} req.body.enabled
 * @returns {{id, wfhAllowed}}
 */
// PATCH /api/admin/users/:id/wfh-access  { enabled }  (SuperAdmin)
// A WFH punch is exempt from the office geofence, so this is a privilege granted
// per person rather than a checkbox every employee gets. Keyed on the user id to
// match the cashbook grant above (the Permissions page works in users), then
// resolved to the EmployeeProfile that actually holds the flag.
const setWfhAccess = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.params.id });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  profile.wfhAllowed = !!req.body.enabled;
  await profile.save();
  res.json({ id: req.params.id, wfhAllowed: profile.wfhAllowed });
});

// The org-wide preference payload, in one place so GET and PUT can't drift.
const orgSettingsPayload = (s) => ({
  includeExecutivesInLists: !!s.includeExecutivesInLists,
  chatEnabled: !!s.chatEnabled,
});

/**
 * Read org-wide settings a SuperAdmin controls.
 * @route GET /api/admin/org-settings  (SuperAdmin)
 * @returns {{includeExecutivesInLists: boolean, chatEnabled: boolean}}
 */
// GET /api/admin/org-settings  (SuperAdmin)
// Org-wide preferences a SuperAdmin controls: whether CEO/MD show up in
// employee-selection pickers, and whether the chat module is switched on.
const getOrgSettings = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  res.json(orgSettingsPayload(await Setting.getSettings()));
});

/**
 * Update org-wide settings.
 * @route PUT /api/admin/org-settings  (SuperAdmin)
 * @param {boolean} [req.body.includeExecutivesInLists]
 * @param {boolean} [req.body.chatEnabled]
 * @returns {{includeExecutivesInLists: boolean, chatEnabled: boolean}}
 */
// PUT /api/admin/org-settings  (SuperAdmin)
const updateOrgSettings = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  if (req.body.includeExecutivesInLists !== undefined) {
    s.includeExecutivesInLists = !!req.body.includeExecutivesInLists;
  }
  if (req.body.chatEnabled !== undefined) {
    s.chatEnabled = !!req.body.chatEnabled;
  }
  await s.save();
  res.json(orgSettingsPayload(s));
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
  setCashbookAccess,
  setWfhAccess,
  getOrgSettings,
  updateOrgSettings,
};
