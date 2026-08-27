/**
 * Password-reset-request controller — a public login-page form lets locked-out
 * employees ask for a reset; HR/SuperAdmin list the requests, mark them Resolved,
 * or set a new password for the account (which invalidates existing sessions).
 */
const asyncHandler = require('express-async-handler');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const User = require('../models/User');
const { resolveLoginUser } = require('../utils/loginIdentity');

/**
 * The account a reset request is for.
 *
 * Resolved by EMPLOYEE CODE first and only then by email. A work address can be
 * held by a resigned account and by the person who inherited the seat, so
 * matching on it alone could hand an HR Manager the wrong account and let them
 * overwrite an innocent person's password. The employee code identifies exactly
 * one person for good. resolveLoginUser refuses an ambiguous match outright, so
 * the email fallback returns nothing rather than guessing.
 *
 * @param {Object} doc - the PasswordResetRequest (uses employeeCode, email)
 * @returns {Promise<Object|null>} the User (with +password), or null
 */
async function accountForRequest(doc) {
  if (doc.employeeCode) {
    const { user } = await resolveLoginUser(doc.employeeCode);
    if (user) return user;
  }
  const { user } = await resolveLoginUser(doc.email);
  return user;
}
const Notification = require('../models/Notification');
const { allowedUserIds, cannotSeeUser } = require('../utils/employeeScope');
const { scopeRecipientsToCompany } = require('../services/audience');

// All of these identity fields must be supplied on the public form
const REQUIRED = ['name', 'email', 'employeeCode', 'phone', 'designation', 'department'];

/**
 * Public: submit a password-reset request from the login page.
 * @route POST /api/password-reset-requests  (PUBLIC, no auth)
 * @param {Object} req.body - name, email, employeeCode, phone, designation, department (all required); optional reason
 * @returns {{ok: boolean}} (201)
 * @sideeffect notifies every active HR Manager and SuperAdmin
 */
// POST /api/password-reset-requests  (PUBLIC — submitted from the login page)
const createPasswordResetRequest = asyncHandler(async (req, res) => {
  const body = req.body || {};
  for (const f of REQUIRED) {
    if (!body[f] || !String(body[f]).trim()) {
      res.status(400);
      throw new Error('Name, email, employee ID, phone, designation and department are all required.');
    }
  }

  const doc = await PasswordResetRequest.create({
    name: body.name,
    email: body.email,
    employeeCode: body.employeeCode,
    phone: body.phone,
    designation: body.designation,
    department: body.department,
    reason: body.reason ? String(body.reason).trim() : undefined,
  });

  // Notify the active HR Managers and SuperAdmins so either can action it —
  // walled to the requester's company when the email matches an account.
  let admins = (await User.find({
    role: { $in: ['SuperAdmin', 'HRManager'] },
    isActive: true,
  }).select('_id')).map((a) => ({ _id: a._id }));
  const requester = await accountForRequest(doc);
  if (requester) {
    const EmployeeProfile = require('../models/EmployeeProfile');
    const prof = await EmployeeProfile.findOne({ user: requester._id }).select('company').lean();
    const kept = await scopeRecipientsToCompany(admins.map((a) => a._id), prof?.company);
    admins = kept.map((id) => ({ _id: id }));
  }

  if (admins.length) {
    await Notification.insertMany(
      admins.map((a) => ({
        recipient: a._id,
        type: 'password_reset_request',
        title: 'Password reset request',
        body: `${doc.name} (${doc.employeeCode}) requested a password reset.`,
        link: '/admin/password-resets',
      }))
    );
  }

  res.status(201).json({ ok: true });
});

/**
 * List all password-reset requests, newest first.
 * @route GET /api/password-reset-requests  (HR / Admin)
 * @returns {{count: number, requests: Object[]}} with populated resolvedBy
 */
// GET /api/password-reset-requests  (HR / Admin)
const listPasswordResetRequests = asyncHandler(async (req, res) => {
  let requests = await PasswordResetRequest.find()
    .populate('resolvedBy', 'firstName lastName email role')
    .sort({ createdAt: -1 });
  // Company wall: requests are keyed only by the typed-in email, so map each to
  // an account and hide the ones belonging to another company's people. A
  // request matching NO account stays visible to every admin — somebody has to
  // deal with it, and it contains nothing beyond what the requester typed.
  const allowed = await allowedUserIds(req);
  if (allowed) {
    const emails = [...new Set(requests.map((r) => r.email).filter(Boolean))];
    const matched = await User.find({ email: { $in: emails } }).select('email _id').lean();
    const ownerByEmail = new Map(matched.map((u) => [u.email, String(u._id)]));
    requests = requests.filter((r) => {
      const owner = ownerByEmail.get(r.email);
      return !owner || allowed.includes(owner);
    });
  }
  res.json({ count: requests.length, requests });
});

/**
 * Mark a request Resolved without changing the password (e.g. handled offline).
 * @route PATCH /api/password-reset-requests/:id/resolve  (HR / Admin)
 * @param {string} req.params.id - request id
 * @returns {{request: Object}} with populated resolvedBy
 */
// PATCH /api/password-reset-requests/:id/resolve  (HR / Admin)
// Either an HR Manager or a SuperAdmin marking it done flips it to Resolved.
const resolvePasswordResetRequest = asyncHandler(async (req, res) => {
  const doc = await PasswordResetRequest.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Request not found');
  }
  doc.status = 'Resolved';
  doc.resolvedBy = req.user._id;
  doc.resolvedAt = new Date();
  await doc.save();
  await doc.populate('resolvedBy', 'firstName lastName email role');
  res.json({ request: doc });
});

/**
 * Set a new password for the account on the request, then mark it Resolved.
 * @route PATCH /api/password-reset-requests/:id/reset  (HR / Admin)
 * @param {string} req.params.id - request id
 * @param {string} req.body.newPassword - min 8 chars
 * @returns {{request: Object}}
 * @sideeffect re-hashes password and invalidates the user's sessions; notifies the user
 */
// PATCH /api/password-reset-requests/:id/reset  (HR / Admin)
// Set a new password for the account named on the request, then resolve it.
// Saving the user bumps tokenVersion, so the employee is logged out everywhere.
const resetUserPassword = asyncHandler(async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).trim().length < 8) {
    res.status(400);
    throw new Error('A new password of at least 8 characters is required.');
  }

  const doc = await PasswordResetRequest.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Request not found');
  }

  const user = await accountForRequest(doc);
  if (!user) {
    res.status(404);
    throw new Error('No user account found for this employee code or email. Check the request details.');
  }

  // Permission gate: HR Managers may only reset Employee accounts; admin accounts are SuperAdmin-only.
  if (req.user.role !== 'SuperAdmin' && user.role !== 'Employee') {
    res.status(403);
    throw new Error('Only a SuperAdmin may reset admin accounts.');
  }
  // Company wall: an admin cannot set the password of another company's account.
  if (await cannotSeeUser(req, user._id)) {
    res.status(403);
    throw new Error('This account belongs to a company outside your access.');
  }

  user.password = String(newPassword); // pre-save hook hashes + invalidates sessions
  await user.save();

  doc.status = 'Resolved';
  doc.resolvedBy = req.user._id;
  doc.resolvedAt = new Date();
  await doc.save();
  await doc.populate('resolvedBy', 'firstName lastName email role');

  await Notification.create({
    recipient: user._id,
    type: 'password_reset',
    title: 'Your password was reset',
    body: 'HR has reset your password. Please sign in again with the new password.',
  });

  res.json({ request: doc });
});

module.exports = {
  createPasswordResetRequest,
  listPasswordResetRequests,
  resolvePasswordResetRequest,
  resetUserPassword,
};
