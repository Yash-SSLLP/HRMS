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
// Notifications go through the dispatch service, never straight to the
// collection: notify()/notifyMany() write the row AND send the push, and a row
// with no push is a request nobody hears about until they next open the portal.
const { notify, notifyMany } = require('../services/notify');
const { allowedUserIds, cannotSeeUser } = require('../utils/employeeScope');
const { scopeRecipientsToCompany } = require('../services/audience');
const { enqueueMail } = require('../services/email');
const { renderMail } = require('../services/templates');
// The public web app, for the link in that mail. Never hardcoded — a localhost
// link in somebody's inbox is dead on arrival; see config/appUrl.
const { appBaseUrl } = require('../config/appUrl');
const COMPANY = require('../config/company');

/**
 * Email the SAME people the in-app notification goes to.
 *
 * A notification is only seen by somebody already looking at the portal, and the
 * person who raised this cannot get into the portal at all — so the request has
 * to reach HR where they actually are. It carries a link straight to the queue.
 *
 * Wording comes from the editable registry ('passwordReset.request'), and the
 * HTML is built out of that same rendered text, so editing the template in
 * Settings → Templates moves both halves rather than only the plain-text one.
 *
 * NEVER allowed to break the request: this endpoint is PUBLIC and its caller is
 * locked out, so a mail problem must not become a 500 in front of somebody who
 * cannot sign in. The caller logs and carries on — the notification and the row
 * in the list are already there.
 *
 * @param {Array<*>} recipientIds - User ids, already company-scoped
 * @param {Object} doc - the PasswordResetRequest just created
 */
async function mailAdmins(recipientIds, doc) {
  // Addresses are fetched here rather than carried down: scopeRecipientsToCompany
  // answers in ids, and threading a second field through it would only give this
  // one caller a reason to change a shared helper.
  const rows = await User.find({ _id: { $in: recipientIds } }).select('email').lean();
  const to = [...new Set(rows.map((u) => u.email).filter(Boolean))];
  if (!to.length) return;

  const link = `${appBaseUrl()}/admin/password-resets`;
  const vars = {
    name: doc.name,
    employeeCode: doc.employeeCode,
    email: doc.email,
    phone: doc.phone,
    designation: doc.designation,
    department: doc.department,
    // An unsupplied variable is deliberately left as its {{placeholder}} by the
    // renderer — right for a missing salary figure, wrong for an optional
    // free-text box — so an absent reason is spelled out instead.
    reason: doc.reason || 'Not given',
    link,
    companyName: COMPANY.name,
  };

  const { subject, text } = await renderMail('passwordReset.request', vars, {
    subject: `Password reset requested - ${doc.name} (${doc.employeeCode})`,
    body: `${doc.name} (${doc.employeeCode}) has asked for their password to be reset.\n\n${link}`,
  });

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;white-space:pre-wrap;">${esc(p)}</p>`)
    .join('\n  ');
  // The button is the point of the mail, so the URL is ALSO printed in full
  // underneath it — plenty of corporate clients strip or rewrite anchors.
  const html = `<!doctype html>
<html><body style="font-family:Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.55;max-width:560px;margin:0 auto;padding:24px;">
  ${paragraphs}
  <p style="margin:24px 0;">
    <a href="${esc(link)}"
       style="display:inline-block;padding:12px 24px;background:#111111;color:#ffffff;
              text-decoration:none;border-radius:6px;font-weight:600;">
      Open password reset requests
    </a>
  </p>
  <p style="font-size:13px;color:#6b7280;">
    Or paste this link into your browser:<br>
    <code style="background:#f4f4f5;padding:2px 6px;border-radius:3px;">${esc(link)}</code>
  </p>
</body></html>`;

  await enqueueMail({ to, subject, text, html }, { type: 'passwordResetRequest', id: doc._id });
}

// All of these identity fields must be supplied on the public form
const REQUIRED = ['name', 'email', 'employeeCode', 'phone', 'designation', 'department'];

/**
 * Public: submit a password-reset request from the login page.
 * @route POST /api/password-reset-requests  (PUBLIC, no auth)
 * @param {Object} req.body - name, email, employeeCode, phone, designation, department (all required); optional reason
 * @returns {{ok: boolean}} (201)
 * @sideeffect notifies AND emails every active HR Manager and SuperAdmin in scope
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
    // The mail goes to exactly the same people as the notification below, so
    // the two can never disagree about who was told. Failure is logged, not
    // thrown — see mailAdmins.
    try {
      await mailAdmins(admins.map((a) => a._id), doc);
    } catch (err) {
      console.error('Password-reset request email failed:', err.message);
    }

    // notifyMany, not Notification.insertMany: this used to write the rows
    // directly, which skipped the push entirely — the request sat in the bell
    // until somebody happened to open the admin portal, while the person who
    // raised it was locked out and waiting. `audience: 'admin'` keeps it out of
    // My Portal for an HR Manager, who is an employee too and cannot action it
    // from there.
    await notifyMany(admins.map((a) => a._id), {
      type: 'password_reset_request',
      audience: 'admin',
      title: 'Password reset request',
      body: `${doc.name} (${doc.employeeCode}) requested a password reset.`,
      link: '/admin/password-resets',
    });
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
    // EVERY account holding the address, not one of them: a reissued work
    // address belongs to both the person who left and the person who took the
    // seat, and a Map keyed on it would keep whichever Mongo returned last —
    // hiding the request from the admin who can actually action it. The wall
    // opens when ANY of the matched accounts is in this admin's scope.
    const ownersByEmail = new Map();
    matched.forEach((u) => {
      const key = String(u.email || '').toLowerCase();
      if (!ownersByEmail.has(key)) ownersByEmail.set(key, []);
      ownersByEmail.get(key).push(String(u._id));
    });
    requests = requests.filter((r) => {
      const owners = ownersByEmail.get(String(r.email || '').toLowerCase());
      return !owners || !owners.length || owners.some((id) => allowed.includes(id));
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

  // The person being reset is signed out of every device by the save above, so
  // this is the one message that has to reach them wherever they are.
  await notify({
    recipient: user._id,
    type: 'password_reset',
    audience: 'all',
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
