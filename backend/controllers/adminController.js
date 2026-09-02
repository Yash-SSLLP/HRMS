/**
 * Admin controller — user-account administration (User model). SuperAdmin manages
 * all accounts and roles; HRManager is limited to Employee accounts. Covers user
 * CRUD, activate/deactivate, per-HRManager permission grants, a standalone
 * cashbook-access flag, and org-wide settings (executive visibility in pickers).
 * Creating/promoting HR/L&D/Accounts staff auto-provisions an EmployeeProfile.
 */
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const { activeAccountWithEmail } = require('../utils/loginIdentity');
const { ROLES } = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const Company = require('../models/Company');
const { ensureEmployeeProfile } = require('../services/ensureProfile');
const { purgePerson } = require('../services/purgePerson');
const { PERMISSIONS, GRANTABLE_ROLES, isValidPermission } = require('../config/permissions');
const { EXECUTIVE_ROLES, shouldExcludeExecutives } = require('../utils/visibility');
const { scopeUserFilter } = require('../utils/employeeScope');
const { isEditingExec, canEditManagerProfiles, isManagerProfileRole } = require('../middleware/authMiddleware');
const { enqueueMail } = require('../services/email');
const COMPANY = require('../config/company');
const path = require('path');
const storage = require('../services/storage');
const { invalidateBranding } = require('../services/branding');

// Shared resolver — see config/appUrl.js.
const { appBaseUrl: APP_BASE_URL } = require('../config/appUrl');

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
  // Company wall: a non-Backend viewer only sees accounts of their own
  // company (plus group-wide execs); no-op for SuperAdmin / unrestricted.
  await scopeUserFilter(req, filter);
  const users = await User.find(filter).sort({ createdAt: -1 });

  // Attach the two attendance grants that live on the employee profile — may
  // they mark a punch as work-from-home, and does the office geofence apply to
  // them at all. One extra query for the whole page rather than a lookup per
  // row; users without a profile (CEO/MD) simply come back false.
  const grantsByUser = new Map(
    (await EmployeeProfile.find({ user: { $in: users.map((u) => u._id) } })
      .select('user wfhAllowed remotePunchAllowed').lean())
      .map((p) => [String(p.user), { wfh: !!p.wfhAllowed, remotePunch: !!p.remotePunchAllowed }])
  );
  const out = users.map((u) => ({
    ...u.toJSON(),
    wfhAllowed: grantsByUser.get(String(u._id))?.wfh || false,
    remotePunchAllowed: grantsByUser.get(String(u._id))?.remotePunch || false,
    hasProfile: grantsByUser.has(String(u._id)),
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
  const user = await User.findOne(await scopeUserFilter(req, { _id: req.params.id }));
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  res.json({ user });
});

/**
 * Celebration dates accepted on a USER account, for CEO/MD only.
 *
 * A CEO/MD has no EmployeeProfile by design (utils/visibility NON_STAFF_ROLES),
 * so there is nowhere else to put their birthday — and without one they never
 * appeared on anybody's calendar. Every other role DOES have a profile, which
 * stays the single source of truth for their dates; sending these fields for a
 * staff account is ignored rather than quietly creating a second copy that
 * payroll and confirmations would not see.
 *
 * `''`/null clears a date; a field that is absent is left alone.
 * @param {string} role - the role the account will hold
 * @param {object} body - the request body
 * @returns {object} a partial User update ({} when the role has a profile)
 */
function execCelebrationDates(role, body) {
  if (!EXECUTIVE_ROLES.includes(role)) return {};
  const out = {};
  for (const key of ['dateOfBirth', 'dateOfJoining', 'dateOfMarriage']) {
    if (body[key] === undefined) continue;
    const raw = body[key];
    if (raw === null || raw === '') { out[key] = null; continue; }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) out[key] = d;
  }
  return out;
}

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
  // CEO/MD celebration dates (see execCelebrationDates below) — every other
  // role keeps its dates on the employee profile, so nothing is read here.
  const celebrationDates = execCelebrationDates(role, req.body);

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

  // Only a LIVE account blocks the address. A resigned employee's account is
  // deactivated, which frees their work address for whoever fills the seat —
  // the reason email is no longer a unique key (see utils/loginIdentity).
  const exists = await activeAccountWithEmail(email);
  if (exists) {
    res.status(409);
    throw new Error('That email is already in use by an active account. Deactivate it first if this address is being reissued.');
  }

  const user = await User.create({
    email,
    password,
    firstName,
    lastName,
    role,
    phone,
    isActive: isActive !== undefined ? isActive : true,
    ...celebrationDates,
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
  // Company wall on the write path too: a non-Backend admin cannot address
  // another company's account by id (reads as not-found, same as the list).
  const user = await User.findOne(await scopeUserFilter(req, { _id: req.params.id }));
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  // Permission gate: HRManagers can only touch Employee accounts. They cannot edit other
  // admins, and they cannot promote anyone to/from an admin role.
  //
  // The one exception is a MANAGER account, for an admin a SuperAdmin has
  // granted the manager-profile permission (User.managerProfileAccess). The
  // employee edit form carries the person's phone and login email alongside
  // their profile fields, so refusing the account call outright would leave that
  // grant half-usable — you could correct a manager's department but not their
  // number. It buys those identity fields only, and they still go to the CEO/MD
  // for approval below; the role, the password and activation stay SuperAdmin-only.
  const grantedManagerEdit = isManagerProfileRole(user.role) && canEditManagerProfiles(req.user);
  if (req.user.role !== 'SuperAdmin' && user.role !== 'Employee' && !grantedManagerEdit) {
    res.status(403);
    throw new Error('Only SuperAdmin may modify admin accounts');
  }

  const { firstName, lastName, role, phone, isActive, password, email } = req.body;

  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      res.status(400);
      throw new Error(`role must be one of ${ROLES.join(', ')}`);
    }
    // What role somebody holds is a SuperAdmin decision, so anyone else may only
    // send the role the account already has (the edit form does, unchanged).
    // Comparing against the CURRENT role rather than against 'Employee' is what
    // stops a granted admin demoting a manager to Employee and then editing the
    // record with no grant needed at all.
    if (role !== user.role && req.user.role !== 'SuperAdmin') {
      res.status(403);
      throw new Error('Only SuperAdmin may assign admin roles');
    }
    user.role = role;
  }

  // Resetting a password or switching an account off are not part of "edit this
  // manager's details" — they stay where they were, with the SuperAdmin.
  if (grantedManagerEdit && req.user.role !== 'SuperAdmin'
      && (password !== undefined || isActive !== undefined)) {
    res.status(403);
    throw new Error("Only a Super Admin may set a Manager's password or change their account status.");
  }

  // The employee's identity details (name, login email, phone) are catalogue
  // fields: the Backend and an edit-mode exec change them directly (audited),
  // but an HR Manager cannot — each change to an Employee is queued to that
  // employee's company CEO/MD instead. Role / isActive / password are
  // operational and stay direct for whoever is allowed to set them.
  const writesDirectly = req.user.role === 'SuperAdmin' || isEditingExec(req.user);
  const hrRouting = !writesDirectly && req.user.role === 'HRManager' && (user.role === 'Employee' || grantedManagerEdit);
  const { auditFieldChange } = require('../services/profileChanges');
  const IDENTITY = [
    { key: 'firstName', label: 'First Name', incoming: firstName },
    { key: 'lastName', label: 'Last Name', incoming: lastName },
    { key: 'phone', label: 'Phone', incoming: phone },
    { key: 'email', label: 'Login Email', incoming: email, isEmail: true },
  ];
  let emailChanged = false;
  const identityQueue = []; // HR → exec
  const identityAudits = []; // direct → audit
  for (const f of IDENTITY) {
    if (f.incoming === undefined) continue;
    const next = f.isEmail ? String(f.incoming).toLowerCase().trim() : f.incoming;
    const cur = user.get(f.key);
    if (String(next ?? '') === String(cur ?? '')) continue; // unchanged
    if (hrRouting) { identityQueue.push({ field: f.key, value: next }); continue; }
    // Direct apply (Backend / edit-mode exec).
    if (f.isEmail) {
      if (!next) { res.status(400); throw new Error('Email cannot be empty'); }
      const clash = await activeAccountWithEmail(next, user._id);
      if (clash) { res.status(409); throw new Error('That email is already in use by another active account'); }
      user.email = next;
      emailChanged = true;
    } else {
      user.set(f.key, next);
    }
    identityAudits.push({ meta: { label: f.label }, from: cur ?? '', to: next ?? '' });
  }

  if (isActive !== undefined) user.isActive = isActive;
  if (password) user.password = password; // pre-save hook re-hashes

  // CEO/MD celebration dates. Keyed on the role the account ENDS UP with, so
  // dates sent alongside a promotion to CEO are kept; they are not identity
  // fields and never route through the CEO/MD approval queue — a birthday is a
  // catalogue entry, and only a Super Admin reaches this branch anyway (an HR
  // Manager cannot edit an exec account at all).
  Object.assign(user, execCelebrationDates(user.role, req.body));

  await user.save();

  // Audit the direct identity edits, then queue the HR ones for the exec.
  const auditTarget = { name: `${user.firstName || ''} ${user.lastName || ''}`.trim() };
  identityAudits.forEach((c) => auditFieldChange(req.user, c.meta, c.from, c.to, auditTarget));
  let queuedForApproval = 0;
  if (identityQueue.length) {
    const { queueAdminChange } = require('./changeRequestController');
    for (const q of identityQueue) {
      // eslint-disable-next-line no-await-in-loop
      const cr = await queueAdminChange(req.user, user._id, q.field, q.value);
      if (cr) queuedForApproval += 1;
    }
  }

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

  res.json({ user, queuedForApproval });
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
  // Same cascade the employee-delete route runs, so removing someone from either
  // screen leaves the same (empty) trail. Previously this deleted the login only
  // and stranded their EmployeeProfile plus everything hanging off it.
  const report = await purgePerson({ userId: user._id });
  res.json({ id: req.params.id, deleted: true, purged: report });
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
 * @param {string} req.params.id - user id (must hold a GRANTABLE_ROLES role)
 * @param {string[]} req.body.permissions - valid capability keys (deduped)
 * @returns {{user: Object}}
 */
// PATCH /api/admin/users/:id/permissions  (SuperAdmin only — enforced by route)
// Body: { permissions: [key,...] }. Meaningful for HR Manager and Manager
// accounts (see GRANTABLE_ROLES); other roles are gated by role alone.
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
  if (!GRANTABLE_ROLES.includes(user.role)) {
    res.status(400);
    throw new Error(`Permissions apply only to ${GRANTABLE_ROLES.join(' and ')} accounts.`);
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
 * Grant or revoke standalone Expenses access for any user (role-independent flag).
 * @route PATCH /api/admin/users/:id/expenses-access  (SuperAdmin)
 * @param {string} req.params.id - user id
 * @param {boolean} req.body.enabled
 * @returns {{id, expensesAccess}}
 */
// PATCH /api/admin/users/:id/expenses-access  { enabled }  (SuperAdmin)
// Grant or revoke expense-claim review for ANY user/employee — the standalone
// twin of cashbook-access above, so reimbursements can be settled by whoever
// actually handles them, regardless of role.
const setExpensesAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  user.expensesAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, expensesAccess: user.expensesAccess });
});

/**
 * Grant or revoke the standalone Employee-khata grant — the module itself.
 * Role-independent like cashbook and expenses above: the person who actually
 * hands cash to staff (a site in-charge, a branch supervisor) is usually not an
 * admin. It does NOT let them download the ledger; that is the separate grant
 * below.
 * @route PATCH /api/admin/users/:id/khata-access  (SuperAdmin)
 * @param {boolean} req.body.enabled
 * @returns {{id, khataAccess}}
 */
const setKhataAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  user.khataAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, khataAccess: user.khataAccess });
});

/**
 * Grant or revoke permission to DOWNLOAD the khata as a spreadsheet.
 *
 * Its own grant rather than part of khata access, because an export takes every
 * employee's borrowing history out of the system in a file that can be mailed
 * on. No role confers it (see middleware canExportKhata) — a SuperAdmin names
 * each person who may do it, and that person may be anyone at all.
 * @route PATCH /api/admin/users/:id/khata-export-access  (SuperAdmin)
 * @param {boolean} req.body.enabled
 * @returns {{id, khataExportAccess}}
 */
const setKhataExportAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  user.khataExportAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, khataExportAccess: user.khataExportAccess });
});

/**
 * Grant/revoke the standalone Assets grant. Role-independent by design, like
 * cashbook and expenses above: the person who looks after company hardware is
 * usually an ordinary employee, not an admin.
 * @route PATCH /api/admin/users/:id/assets-access  (SuperAdmin)
 * @param {boolean} req.body.enabled
 * @returns {{id, assetsAccess}}
 */
const setAssetsAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  user.assetsAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, assetsAccess: user.assetsAccess });
});

/**
 * Grant or revoke permission to edit the profiles of MANAGER accounts.
 *
 * Its own grant rather than part of `employees.manage`, for the same reason the
 * khata download is separate from the khata: an HR Manager with no `permissions`
 * array holds every catalogued capability by default, so anything folded into
 * that catalogue would land on every HR account at once. This one is meant to be
 * an explicit, named list — the Backend decides WHICH HR may edit the people who
 * approve their own team's leave and attendance.
 * @route PATCH /api/admin/users/:id/manager-profile-access  (SuperAdmin)
 * @param {boolean} req.body.enabled
 * @returns {{id, managerProfileAccess}}
 */
const setManagerProfileAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  // Meaningless on any other role — a SuperAdmin already may, and nobody else
  // can edit employee profiles at all. Refuse rather than store a dead flag.
  if (!GRANTABLE_ROLES.includes(user.role)) {
    res.status(400);
    throw new Error(`Editing Manager profiles applies only to ${GRANTABLE_ROLES.join(' and ')} accounts.`);
  }
  user.managerProfileAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, managerProfileAccess: user.managerProfileAccess });
});

/**
 * Switch a CEO/MD account between view-only and edit mode.
 * @route PATCH /api/admin/users/:id/exec-edit-access  (SuperAdmin)
 * @param {string} req.params.id - user id (must be a CEO or MD account)
 * @param {boolean} req.body.enabled
 * @returns {{id, execEditAccess}}
 */
// PATCH /api/admin/users/:id/exec-edit-access  { enabled }  (SuperAdmin)
// CEO/MD are read-only executives by default. Switching this on gives that one
// account write access equivalent to an HR Manager with every capability —
// SuperAdmin-only areas (permissions, org settings, audit log) stay closed. The
// gate itself lives in middleware/authMiddleware.js.
const setExecEditAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  // Meaningless on any other role — the flag is only ever read for CEO/MD, so
  // refuse rather than silently store a value that does nothing.
  if (!EXECUTIVE_ROLES.includes(user.role)) {
    res.status(400);
    throw new Error('Edit mode applies to CEO and MD accounts only.');
  }
  user.execEditAccess = !!req.body.enabled;
  await user.save();
  res.json({ id: user._id, execEditAccess: user.execEditAccess });
});

/**
 * Set which companies a CEO/MD may see and manage. An empty list clears the
 * restriction (the exec sees every company again); a non-empty list narrows
 * them to exactly those companies. See models/User.js `companies`.
 * @route PATCH /api/admin/users/:id/companies  { companyIds: string[] }  (SuperAdmin)
 * @returns {{id: string, companies: string[]}}
 */
const setExecCompanies = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (!EXECUTIVE_ROLES.includes(user.role)) {
    res.status(400);
    throw new Error('Company access applies to CEO and MD accounts only.');
  }
  const ids = [...new Set((req.body.companyIds || []).map(String))].filter(Boolean);
  if (ids.length) {
    // Reject unknown ids so a typo can't silently lock the exec out of everything.
    const found = await Company.countDocuments({ _id: { $in: ids } });
    if (found !== ids.length) {
      res.status(400);
      throw new Error('One or more companies do not exist.');
    }
  }
  // Empty list → clear the restriction (undefined = all companies).
  user.companies = ids.length ? ids : undefined;
  await user.save();
  res.json({ id: user._id, companies: (user.companies || []).map(String) });
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

/**
 * Let one employee check in and out from anywhere.
 *
 * A SEPARATE GRANT FROM WFH, and the difference is the whole point. WFH is
 * something the employee declares on a given punch, and it records that they
 * worked from home that day. This says the office geofence does not apply to
 * this person at all — the answer for site engineers, field sales and drivers,
 * who are legitimately never at the office and should not have to tick
 * "working from home" every morning to avoid being flagged for it.
 *
 * The punch still carries its GPS fix and still appears on the punch map; what
 * changes is that a distant punch stops counting as one that needs explaining.
 * Keyed on the user id like the other grants on the Permissions page, then
 * resolved to the EmployeeProfile that holds the flag.
 * @route PATCH /api/admin/users/:id/remote-punch-access  (SuperAdmin)
 * @param {string} req.params.id - user id
 * @param {boolean} req.body.enabled
 * @returns {{id, remotePunchAllowed}}
 */
const setRemotePunchAccess = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.params.id });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  profile.remotePunchAllowed = !!req.body.enabled;
  await profile.save();
  res.json({ id: req.params.id, remotePunchAllowed: profile.remotePunchAllowed });
});

// The org-wide preference payload, in one place so GET and PUT can't drift.
// `branding` reports only whether each image EXISTS plus its captions — never the
// GridFS key, which is an internal handle the browser has no use for (same rule
// Candidate.toJSON follows for letterPath). The UI fetches the bytes from the
// dedicated logo/signature endpoints below.
const orgSettingsPayload = (s) => {
  const { SIGNATURE_KEYS, SIGNATURE_LABELS } = require('../models/Setting');
  const sigs = s.branding?.signatures || [];
  return {
    includeExecutivesInLists: !!s.includeExecutivesInLists,
    chatEnabled: !!s.chatEnabled,
    // Does a cash-advance request need a CEO/MD sanction before the accounts
    // team sees it? Defaults ON, so an untouched deployment gains the gate.
    khataAdvanceApprovalRequired: s.khataAdvanceApprovalRequired !== false,
    // The contact strip on the khata statement PDF. Always sent as a pair so the
    // form can render two empty inputs rather than guess at a missing shape.
    documentFooter: {
      helpline: s.documentFooter?.helpline || '',
      note: s.documentFooter?.note || '',
    },
    branding: {
      hasLogo: !!s.branding?.logoPath,
      signatures: SIGNATURE_KEYS.map((key) => {
        const hit = sigs.find((x) => x.key === key);
        return {
          key,
          label: SIGNATURE_LABELS[key],
          hasImage: !!hit?.storagePath,
          signatoryName: hit?.signatoryName || '',
          signatoryTitle: hit?.signatoryTitle || '',
          updatedAt: hit?.updatedAt || null,
        };
      }),
    },
  };
};

// ---------------------------------------------------------------------------
// Letterhead branding — company logo + CEO/MD/HR signature images.
// SuperAdmin only (the routes enforce it). Stored in GridFS via services/storage
// and referenced from the Setting singleton, mirroring the avatar flow in
// controllers/authController.js.
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};
const contentTypeFor = (p) => CONTENT_TYPES[path.extname(String(p || '')).toLowerCase()] || 'image/png';

/**
 * Upload the company logo used on every letterhead.
 * @route POST /api/admin/org-settings/logo  (SuperAdmin, multipart field "image")
 */
const uploadBrandingLogo = asyncHandler(async (req, res) => {
  if (!req.file) { res.status(400); throw new Error('No image uploaded'); }
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  const previous = s.branding?.logoPath;
  const { storagePath } = await storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'branding',
    ownerId: 'logo',
    originalName: req.file.originalname || 'logo.png',
  });
  s.branding = s.branding || {};
  s.branding.logoPath = storagePath;
  await s.save();
  invalidateBranding();
  // Only after the new pointer is safely persisted — a failed delete must never
  // orphan the record we just wrote.
  if (previous && previous !== storagePath) storage.remove(previous).catch(() => {});
  res.json(orgSettingsPayload(s));
});

/**
 * Remove the company logo, reverting letters to the bundled default.
 * @route DELETE /api/admin/org-settings/logo  (SuperAdmin)
 */
const deleteBrandingLogo = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  const previous = s.branding?.logoPath;
  if (s.branding) s.branding.logoPath = '';
  await s.save();
  invalidateBranding();
  if (previous) storage.remove(previous).catch(() => {});
  res.json(orgSettingsPayload(s));
});

/**
 * Stream the company logo back. Protected: it is only ever shown inside the
 * admin UI, and the PDF renderers read the bytes from GridFS directly.
 * @route GET /api/admin/org-settings/logo  (SuperAdmin)
 */
const getBrandingLogo = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const s = await Setting.getSettings();
  const p = s.branding?.logoPath;
  if (!p) return res.status(404).json({ message: 'No logo uploaded' });
  res.setHeader('Content-Type', contentTypeFor(p));
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (!(await storage.streamTo(p, res))) return res.status(404).json({ message: 'File not found' });
});

/**
 * Upload (or replace) one signature slot, and optionally its printed name/title.
 * @route POST /api/admin/org-settings/signature/:key  (SuperAdmin, field "image")
 * @param {'ceo'|'md'|'hr'} req.params.key
 */
const uploadBrandingSignature = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const { SIGNATURE_KEYS } = Setting;
  const key = String(req.params.key || '').toLowerCase();
  if (!SIGNATURE_KEYS.includes(key)) {
    res.status(400);
    throw new Error(`Unknown signature slot. Expected one of: ${SIGNATURE_KEYS.join(', ')}`);
  }
  const s = await Setting.getSettings();
  s.branding = s.branding || {};
  s.branding.signatures = s.branding.signatures || [];
  const existing = s.branding.signatures.find((x) => x.key === key);
  const previous = existing?.storagePath;

  // The image is optional on a re-save so the captions can be edited alone —
  // but a slot with no image at all is meaningless, so require one to create it.
  let storagePath = previous;
  if (req.file) {
    ({ storagePath } = await storage.saveBuffer({
      buffer: req.file.buffer,
      ownerType: 'branding',
      ownerId: `signature-${key}`,
      originalName: req.file.originalname || `${key}-signature.png`,
    }));
  } else if (!previous) {
    res.status(400);
    throw new Error('No image uploaded');
  }

  const patch = {
    key,
    storagePath,
    signatoryName: req.body.signatoryName !== undefined ? String(req.body.signatoryName).trim() : (existing?.signatoryName || ''),
    signatoryTitle: req.body.signatoryTitle !== undefined ? String(req.body.signatoryTitle).trim() : (existing?.signatoryTitle || ''),
    updatedAt: new Date(),
  };
  if (existing) Object.assign(existing, patch);
  else s.branding.signatures.push(patch);
  await s.save();
  invalidateBranding();
  if (req.file && previous && previous !== storagePath) storage.remove(previous).catch(() => {});
  res.json(orgSettingsPayload(s));
});

/**
 * Clear one signature slot.
 * @route DELETE /api/admin/org-settings/signature/:key  (SuperAdmin)
 */
const deleteBrandingSignature = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const key = String(req.params.key || '').toLowerCase();
  const s = await Setting.getSettings();
  const list = s.branding?.signatures || [];
  const hit = list.find((x) => x.key === key);
  if (hit) {
    s.branding.signatures = list.filter((x) => x.key !== key);
    await s.save();
    invalidateBranding();
    if (hit.storagePath) storage.remove(hit.storagePath).catch(() => {});
  }
  res.json(orgSettingsPayload(s));
});

/**
 * Stream one signature image back for the admin preview.
 * @route GET /api/admin/org-settings/signature/:key  (SuperAdmin)
 */
const getBrandingSignature = asyncHandler(async (req, res) => {
  const Setting = require('../models/Setting');
  const key = String(req.params.key || '').toLowerCase();
  const s = await Setting.getSettings();
  const hit = (s.branding?.signatures || []).find((x) => x.key === key);
  if (!hit?.storagePath) return res.status(404).json({ message: 'No signature uploaded' });
  res.setHeader('Content-Type', contentTypeFor(hit.storagePath));
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (!(await storage.streamTo(hit.storagePath, res))) return res.status(404).json({ message: 'File not found' });
});

/**
 * Read org-wide settings a SuperAdmin controls.
 * @route GET /api/admin/org-settings  (SuperAdmin)
 * @returns {{includeExecutivesInLists: boolean, chatEnabled: boolean, khataAdvanceApprovalRequired: boolean}}
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
 * @param {boolean} [req.body.khataAdvanceApprovalRequired]
 * @returns {{includeExecutivesInLists: boolean, chatEnabled: boolean, khataAdvanceApprovalRequired: boolean}}
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
  if (req.body.khataAdvanceApprovalRequired !== undefined) {
    s.khataAdvanceApprovalRequired = !!req.body.khataAdvanceApprovalRequired;
  }
  // Each half is settable on its own, and an empty string is a real value —
  // clearing the helpline is how you take the number off the document.
  if (req.body.documentFooter && typeof req.body.documentFooter === 'object') {
    const f = req.body.documentFooter;
    if (f.helpline !== undefined) s.documentFooter.helpline = String(f.helpline).trim().slice(0, 40);
    if (f.note !== undefined) s.documentFooter.note = String(f.note).trim().slice(0, 120);
  }
  await s.save();
  res.json(orgSettingsPayload(s));
});


/**
 * How recently an account must have been seen to count as signed in.
 *
 * There are no server-side sessions to enumerate — a JWT is valid wherever it
 * is held — so "signed in" is inferred from activity: `protect` stamps
 * `lastSeenAt` on every authenticated request (throttled), and anyone whose
 * stamp is inside this window has a live token and is using it.
 */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
// How far back the page lists at all, so an idle account is still visible with
// "last seen 3 hours ago" rather than vanishing the moment it goes quiet.
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Every account's credential state (Backend only).
 *
 * There is deliberately NO password field in this response, and there cannot be
 * one: passwords are bcrypt-hashed by the User pre-save hook, which is one-way,
 * so the server has never held anyone's actual password — only a verifier to
 * compare a login attempt against. What this screen answers instead is the
 * question a plaintext list is usually reached for: who can still get in, who
 * has never signed in, whose password is old, and who is still sitting on one an
 * admin handed them.
 *
 * @route GET /api/admin/account-security
 * @param {string} [req.query.q] - name / email / employee-code search
 * @returns {{count, accounts: Object[]}}
 */
// GET /api/admin/account-security
const listAccountSecurity = asyncHandler(async (req, res) => {
  const users = await User.find({})
    .select('firstName lastName email role isActive lastLoginAt passwordChangedAt mustChangePassword createdAt')
    .sort({ isActive: -1, firstName: 1 })
    .lean();

  // One query for the whole page rather than a lookup per row. CEO/MD have no
  // employee profile at all, so they simply come back without a code — they
  // sign in with the "CEO"/"MD" alias instead (see utils/loginIdentity).
  const codeByUser = new Map(
    (await EmployeeProfile.find({ user: { $in: users.map((u) => u._id) } })
      .select('user employeeCode department').lean())
      .map((p) => [String(p.user), { code: p.employeeCode || '', department: p.department || '' }])
  );

  let accounts = users.map((u) => {
    const p = codeByUser.get(String(u._id));
    return {
      _id: String(u._id),
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      email: u.email,
      employeeCode: p?.code || '',
      department: p?.department || '',
      role: u.role,
      isActive: u.isActive !== false,
      lastLoginAt: u.lastLoginAt || null,
      // Null means "not recorded since this field was added", which the client
      // must show as unknown — NOT as "never changed", which would be a lie
      // about an account that may well have been updated last week.
      passwordChangedAt: u.passwordChangedAt || null,
      mustChangePassword: !!u.mustChangePassword,
      isSelf: String(u._id) === String(req.user._id),
    };
  });

  const q = (req.query.q || '').trim().toLowerCase();
  if (q) {
    accounts = accounts.filter((a) => `${a.name} ${a.email} ${a.employeeCode}`.toLowerCase().includes(q));
  }

  res.json({ count: accounts.length, accounts });
});

/**
 * Set another account's password (Backend only).
 *
 * The new password is chosen by the admin, applied through the normal pre-save
 * hook (so it is hashed exactly like any other), and flagged
 * `mustChangePassword` — an admin-chosen password is known to at least two
 * people, so it is a way back IN, never a password to keep. Hashing also means
 * this is strictly one-way: the admin has to tell the person what they typed,
 * because nothing here can read it back afterwards.
 *
 * Side effect, inherited from the hook: `tokenVersion` bumps, which signs the
 * account out of every device it was signed in on.
 *
 * @route POST /api/admin/users/:id/reset-password
 * @param {string} req.body.password - the new password (min 8)
 * @returns {{ok: true, name, mustChangePassword: true}}
 */
// POST /api/admin/users/:id/reset-password
const resetUserPassword = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || String(password).length < 8) {
    res.status(400);
    throw new Error('The new password must be at least 8 characters');
  }

  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  // Refused rather than allowed: resetting your own password here would flag
  // your own account and bounce you to the change-password screen mid-task.
  // Account → Change password is the route for that, and it asks for the
  // current one, which is the check that belongs on your own credentials.
  if (String(user._id) === String(req.user._id)) {
    res.status(400);
    throw new Error('That is your own account — use Account → Change password.');
  }

  user.password = password; // pre-save hook hashes it and bumps tokenVersion
  user.mustChangePassword = true;
  await user.save();

  const targetName = `${user.firstName || ''} ${user.lastName || ''}`.trim();

  // Best-effort, both of them: the reset itself is already saved, and neither a
  // failed audit write nor a failed notification may turn it into an error.
  const AuditLog = require('../models/AuditLog');
  AuditLog.create({
    entity: 'User',
    entityId: user._id,
    entityLabel: targetName,
    field: 'password',
    fromStatus: 'set by owner',
    toStatus: 'reset by admin',
    by: req.user._id,
    byName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    byRole: req.user.role,
  }).catch((err) => console.error('password-reset audit failed:', err.message));

  const { notify } = require('../services/notify');
  notify({
    recipient: user._id,
    type: 'general',
    audience: 'all',
    title: 'Your password was reset',
    body: 'An administrator set a new password for your account. Sign in with it and you will be asked to choose your own.',
  }).catch((err) => console.error('password-reset notify failed:', err.message));

  res.json({ ok: true, name: targetName, mustChangePassword: true });
});

/**
 * Ask (or stop asking) an account to choose a new password at its next sign-in.
 *
 * Distinct from resetUserPassword: that one SETS a password, which the admin then
 * has to read out. This changes nothing about the current password — the person
 * signs in with the one they already know and is then held on the change screen.
 * It is the right tool when the password is merely stale or was shared, and the
 * wrong one when they are locked out (they have to be able to sign in first).
 *
 * Deliberately does NOT bump tokenVersion. Doing so would sign the person out of
 * every device the moment an admin ticked a box, mid-task; the flag is about the
 * NEXT sign-in, and it takes hold there on its own.
 *
 * @route POST /api/admin/users/:id/require-password-change
 * @param {boolean} [req.body.required=true] - false clears the request
 * @returns {{ok: true, name, mustChangePassword: boolean}}
 */
// POST /api/admin/users/:id/require-password-change
const requirePasswordChange = asyncHandler(async (req, res) => {
  const required = req.body.required !== false;
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  if (String(user._id) === String(req.user._id)) {
    res.status(400);
    throw new Error('That is your own account — use Account → Change password.');
  }

  // updateOne, not save(): nothing here touches the password, and save() would
  // run the hashing hook for no reason. (An in-memory assignment on `user` would
  // be dead code — it is never saved — so there deliberately isn't one.)
  await User.updateOne({ _id: user._id }, { $set: { mustChangePassword: required } });

  const targetName = `${user.firstName || ''} ${user.lastName || ''}`.trim();

  const AuditLog = require('../models/AuditLog');
  AuditLog.create({
    entity: 'User',
    entityId: user._id,
    entityLabel: targetName,
    field: 'mustChangePassword',
    fromStatus: required ? 'not required' : 'required',
    toStatus: required ? 'required' : 'not required',
    by: req.user._id,
    byName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    byRole: req.user.role,
  }).catch((err) => console.error('require-password-change audit failed:', err.message));

  if (required) {
    const { notify } = require('../services/notify');
    notify({
      recipient: user._id,
      type: 'general',
      audience: 'all',
      title: 'Choose a new password',
      body: 'You will be asked to set a new password the next time you sign in.',
    }).catch((err) => console.error('require-password-change notify failed:', err.message));
  }

  res.json({ ok: true, name: targetName, mustChangePassword: required });
});

/**
 * Which app build each person is running (Backend only).
 *
 * THREE ANSWERS, and the difference between them matters:
 *   - a version  — the phone registered for push and told us its native build;
 *   - "Web only" — the account has NO device registration at all, so as far as
 *     the server knows this person has never opened the Android app;
 *   - "Unknown"  — a device IS registered but recorded no version, which means
 *     it last checked in from a build older than the one that started sending it.
 *     An app that never reported its version cannot be asked retrospectively, so
 *     this is read as "not known", never as "old".
 *
 * The version refreshes on every app open (registerForPush runs on launch), so a
 * row goes stale only when the phone stops opening the app — `lastSeenAt` says
 * how long ago that was, which is what separates "on an old build" from "gone".
 *
 * @route GET /api/admin/app-versions
 * @returns {{latest, count, summary, accounts: Object[]}}
 */
// GET /api/admin/app-versions
const listAppVersions = asyncHandler(async (req, res) => {
  const DeviceToken = require('../models/DeviceToken');

  const users = await User.find({ isActive: true })
    .select('firstName lastName email role')
    .sort({ firstName: 1 })
    .lean();

  const [profiles, devices] = await Promise.all([
    EmployeeProfile.find({ user: { $in: users.map((u) => u._id) } })
      .select('user employeeCode department').lean(),
    DeviceToken.find({ user: { $in: users.map((u) => u._id) } })
      .select('user platform deviceName appVersion appVersionCode lastSeenAt')
      .sort({ lastSeenAt: -1 })
      .lean(),
  ]);

  const profileByUser = new Map(profiles.map((p) => [String(p.user), p]));
  // One person can hold several devices (two phones, or a reinstall leaving a
  // stale row). The sort above is newest-first, so the first hit per user is the
  // device they used most recently — the honest answer to "what are they on".
  const deviceByUser = new Map();
  const deviceCount = new Map();
  for (const d of devices) {
    const k = String(d.user);
    if (!deviceByUser.has(k)) deviceByUser.set(k, d);
    deviceCount.set(k, (deviceCount.get(k) || 0) + 1);
  }

  // What "up to date" means right now. Null when nothing has been published.
  let latest = null;
  try {
    const { currentRelease } = require('./appReleaseController');
    const rel = typeof currentRelease === 'function' ? await currentRelease() : null;
    if (rel) latest = { versionName: rel.versionName, versionCode: rel.versionCode };
  } catch {
    // The release store is not essential to this list — carry on without it.
  }

  const accounts = users.map((u) => {
    const p = profileByUser.get(String(u._id));
    const d = deviceByUser.get(String(u._id));
    const code = d && Number.isFinite(d.appVersionCode) ? d.appVersionCode : null;
    return {
      _id: String(u._id),
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      email: u.email,
      employeeCode: p?.employeeCode || '',
      department: p?.department || '',
      role: u.role,
      // 'web' = no device row at all; 'unknown' = a device that never said.
      state: !d ? 'web' : (d.appVersion ? 'app' : 'unknown'),
      appVersion: d?.appVersion || null,
      appVersionCode: code,
      deviceName: d?.deviceName || '',
      platform: d?.platform || null,
      deviceSeenAt: d?.lastSeenAt || null,
      deviceCount: deviceCount.get(String(u._id)) || 0,
      upToDate: latest && code != null ? code >= latest.versionCode : null,
    };
  });

  const summary = {
    total: accounts.length,
    onLatest: accounts.filter((a) => a.upToDate === true).length,
    behind: accounts.filter((a) => a.upToDate === false).length,
    unknown: accounts.filter((a) => a.state === 'unknown').length,
    webOnly: accounts.filter((a) => a.state === 'web').length,
  };

  res.json({ latest, count: accounts.length, summary, accounts });
});

/**
 * Who is signed in right now (Backend only).
 * @route GET /api/admin/sessions
 * @param {number} [req.query.hours] - how far back to list, 1-168 (default 24)
 * @returns {{activeWindowMinutes, count, activeCount, sessions: Object[]}}
 */
// GET /api/admin/sessions
const listSessions = asyncHandler(async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  const since = new Date(Date.now() - Math.min(hours * 60 * 60 * 1000, RECENT_WINDOW_MS * 7));
  const users = await User.find({
    isActive: true,
    $or: [{ lastSeenAt: { $gte: since } }, { lastLoginAt: { $gte: since } }],
  })
    .select('firstName lastName email role lastSeenAt lastLoginAt')
    .sort({ lastSeenAt: -1 })
    .lean();

  const now = Date.now();
  const sessions = users.map((u) => {
    const seen = u.lastSeenAt ? new Date(u.lastSeenAt).getTime() : 0;
    return {
      _id: u._id,
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      email: u.email,
      role: u.role,
      lastSeenAt: u.lastSeenAt || null,
      lastLoginAt: u.lastLoginAt || null,
      // The one derived field the client would otherwise have to recompute on a
      // clock that may not agree with the server's.
      active: !!seen && now - seen <= ACTIVE_WINDOW_MS,
      isSelf: String(u._id) === String(req.user._id),
    };
  });

  res.json({
    activeWindowMinutes: ACTIVE_WINDOW_MS / 60000,
    hours,
    count: sessions.length,
    activeCount: sessions.filter((s) => s.active).length,
    sessions,
  });
});

/**
 * Sign one account out of every device it is signed in on (Backend only).
 *
 * Bumping `tokenVersion` is the whole mechanism: every JWT already issued
 * carries the old number, `protect` compares them, and the next request from
 * any device is rejected. There is deliberately NO notification, no email and
 * no message of any kind — the person simply finds themselves at the login
 * screen and signs in again as normal, which is what was asked for. Nothing
 * about the account changes: not the password, not the role, not their data.
 * @route POST /api/admin/sessions/:id/logout
 * @returns {{id: string, signedOut: boolean, name: string}}
 */
// POST /api/admin/sessions/:id/logout
const signOutUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }
  // Refused rather than allowed-with-a-warning: an accidental click would end
  // the session doing the clicking, mid-task, with no way to undo it from here.
  if (String(user._id) === String(req.user._id)) {
    res.status(400);
    throw new Error('That is your own account — use Log out for that.');
  }
  // Not user.save(): the pre-save hook re-hashes a password when one is set,
  // and this must touch nothing but the token counter.
  await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 }, $unset: { lastSeenAt: 1 } });
  res.json({
    id: String(user._id),
    signedOut: true,
    name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
  });
});

module.exports = {
  listUsers,
  listSessions,
  signOutUser,
  listAccountSecurity,
  resetUserPassword,
  requirePasswordChange,
  listAppVersions,
  getUser,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  deleteUser,
  getPermissionCatalog,
  updateUserPermissions,
  setCashbookAccess,
  setExpensesAccess,
  setAssetsAccess,
  setKhataAccess,
  setKhataExportAccess,
  setManagerProfileAccess,
  setExecEditAccess,
  setExecCompanies,
  setWfhAccess,
  setRemotePunchAccess,
  getOrgSettings,
  updateOrgSettings,
  uploadBrandingLogo,
  deleteBrandingLogo,
  getBrandingLogo,
  uploadBrandingSignature,
  deleteBrandingSignature,
  getBrandingSignature,
};
