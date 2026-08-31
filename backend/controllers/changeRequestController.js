/**
 * Change-request controller. Three ways a whitelisted profile/credential field
 * (FIELD_CATALOG) gets changed:
 *   • Employee fills a MISSING field  → applied immediately (audited), then locked.
 *   • Employee changes a FILLED field → request routed to their HR partner.
 *   • HR changes an employee's field  → request routed to the company CEO/MD.
 * The Backend (SuperAdmin) edits directly elsewhere; it never raises a request.
 * Secret fields (password) never snapshot or echo their value.
 */
const asyncHandler = require('express-async-handler');
const ChangeRequest = require('../models/ChangeRequest');
const { FIELD_CATALOG } = require('../models/ChangeRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Notification = require('../models/Notification');
const {
  readFieldValue,
  applyFieldValue,
  isEmptyValue,
  resolveHrAssignee,
  resolveExecAssignee,
  auditFieldChange,
} = require('../services/profileChanges');

const USER_FIELDS = 'firstName lastName email role';

// { name, profileId } for the audit trail, by the employee's User id.
async function auditTargetOf(userId) {
  const [user, profile] = await Promise.all([
    User.findById(userId).select('firstName lastName'),
    EmployeeProfile.findOne({ user: userId }).select('_id'),
  ]);
  return {
    name: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
    profileId: profile?._id,
  };
}

/**
 * The catalogue with the caller's current values, whether each is empty (so it
 * can be filled directly) and whether a request is already pending on it.
 * @route GET /api/change-requests/fields
 */
const getFields = asyncHandler(async (req, res) => {
  const pending = await ChangeRequest.find({ targetUser: req.user._id, status: 'pending' }).select('field').lean();
  const pendingSet = new Set(pending.map((p) => p.field));

  const fields = [];
  for (const [key, meta] of Object.entries(FIELD_CATALOG)) {
    const currentValue = meta.secret ? '' : await readFieldValue(req.user._id, meta);
    fields.push({
      key,
      label: meta.label,
      secret: !!meta.secret,
      type: meta.type || (meta.secret ? 'password' : 'text'),
      currentValue,
      // A secret field is never "fillable" (there's always a password).
      isEmpty: !meta.secret && isEmptyValue(currentValue),
      pending: pendingSet.has(key),
    });
  }
  res.json({ fields });
});

/**
 * Employee fills a MISSING field on their own record — applied immediately, no
 * approval. Refused once the field already has a value (use a change request).
 * @route POST /api/change-requests/fill  { field, value }
 */
const fillMissingField = asyncHandler(async (req, res) => {
  const { field, value } = req.body;
  const meta = FIELD_CATALOG[field];
  if (!meta || meta.secret) {
    res.status(400);
    throw new Error('This field cannot be filled directly.');
  }
  if (value == null || String(value).trim() === '') {
    res.status(400);
    throw new Error('A value is required.');
  }
  const current = await readFieldValue(req.user._id, meta);
  if (!isEmptyValue(current)) {
    res.status(409);
    throw new Error('This field is already set. Submit a change request to change it.');
  }
  // Block a double-fill while a request is somehow pending on it.
  const already = await ChangeRequest.findOne({ targetUser: req.user._id, field, status: 'pending' });
  if (already) {
    res.status(409);
    throw new Error('A request for this field is already pending.');
  }

  const newVal = String(value).trim();
  await applyFieldValue(req.user._id, meta, newVal);
  auditFieldChange(req.user, meta, '', newVal, await auditTargetOf(req.user._id));
  res.status(200).json({ ok: true, field, value: await readFieldValue(req.user._id, meta) });
});

/**
 * Employee raises a change request for a FILLED field on their own record →
 * routed to their HR partner.
 * @route POST /api/change-requests  { field, requestedValue, reason }
 */
const createChangeRequest = asyncHandler(async (req, res) => {
  const { field, requestedValue, reason } = req.body;
  const meta = FIELD_CATALOG[field];
  if (!meta) {
    res.status(400);
    throw new Error('Unknown field');
  }
  if (!requestedValue || !String(requestedValue).trim()) {
    res.status(400);
    throw new Error('A requested value is required');
  }
  const dup = await ChangeRequest.findOne({ targetUser: req.user._id, field, status: 'pending' });
  if (dup) {
    res.status(409);
    throw new Error('A request for this field is already pending.');
  }

  const currentValue = meta.secret ? '' : await readFieldValue(req.user._id, meta);
  const assignedTo = await resolveHrAssignee(req.user._id);

  const cr = await ChangeRequest.create({
    requestedBy: req.user._id,
    targetUser: req.user._id,
    approverKind: 'hr',
    assignedTo,
    field,
    fieldLabel: meta.label,
    currentValue,
    requestedValue: String(requestedValue).trim(),
    reason: reason ? String(reason).trim() : undefined,
  });

  if (assignedTo) {
    await Notification.create({
      recipient: assignedTo,
      type: 'change_request',
      audience: 'admin',
      title: 'New change request',
      body: `${req.user.firstName} ${req.user.lastName} requested a change to "${meta.label}".`,
      link: 'change-requests',
    });
  }
  res.status(201).json({ changeRequest: cr });
});

/**
 * HR raises a change on an EMPLOYEE's record → routed to the employee's company
 * CEO/MD. Reusable by the employee-update path so an HR edit becomes a queued
 * exec approval instead of a direct write. Returns the created request (or null
 * if nothing changed).
 * @param {object} actor - the HR user raising it
 * @param {string} targetUserId - the employee's User id
 * @param {string} field - FIELD_CATALOG key
 * @param {string} requestedValue
 * @param {string} [reason]
 */
async function queueAdminChange(actor, targetUserId, field, requestedValue, reason) {
  const meta = FIELD_CATALOG[field];
  if (!meta) throw Object.assign(new Error('Unknown field'), { status: 400 });
  const wanted = requestedValue == null ? '' : String(requestedValue).trim();
  const currentValue = meta.secret ? '' : await readFieldValue(targetUserId, meta);
  if (String(currentValue) === wanted) return null; // no change
  // Collapse a duplicate pending request on the same field.
  const dup = await ChangeRequest.findOne({ targetUser: targetUserId, field, status: 'pending' });
  if (dup) return dup;

  const assignedTo = await resolveExecAssignee(targetUserId);
  const cr = await ChangeRequest.create({
    requestedBy: actor._id,
    targetUser: targetUserId,
    approverKind: 'exec',
    assignedTo,
    field,
    fieldLabel: meta.label,
    currentValue,
    requestedValue: wanted,
    reason: reason ? String(reason).trim() : undefined,
  });
  if (assignedTo) {
    await Notification.create({
      recipient: assignedTo,
      type: 'change_request',
      audience: 'admin',
      title: 'HR change needs your approval',
      body: `${actor.firstName} ${actor.lastName} wants to change "${meta.label}" for an employee.`,
      link: 'change-requests',
    });
  }
  return cr;
}

/**
 * HR raises a single-field change on an employee (→ company CEO/MD).
 * @route POST /api/change-requests/admin  { targetUser, field, requestedValue, reason }
 */
const createAdminChangeRequest = asyncHandler(async (req, res) => {
  if (req.user.role !== 'HRManager') {
    res.status(403);
    throw new Error('Only HR Managers raise change requests for employees. The Backend edits directly.');
  }
  const { targetUser, field, requestedValue, reason } = req.body;
  if (!targetUser) {
    res.status(400);
    throw new Error('targetUser is required');
  }
  // HR may only act on their own assigned employees.
  const profile = await EmployeeProfile.findOne({ user: targetUser }).select('hrPartner');
  if (!profile || String(profile.hrPartner || '') !== String(req.user._id)) {
    res.status(403);
    throw new Error('You can only change details for employees assigned to you.');
  }
  if (!requestedValue || !String(requestedValue).trim()) {
    res.status(400);
    throw new Error('A requested value is required');
  }
  const cr = await queueAdminChange(req.user, targetUser, field, requestedValue, reason);
  if (!cr) {
    res.status(400);
    throw new Error('That value matches what is already on record.');
  }
  res.status(201).json({ changeRequest: cr });
});

/**
 * The caller's own change requests, newest first.
 * @route GET /api/change-requests/mine
 */
const myChangeRequests = asyncHandler(async (req, res) => {
  const changeRequests = await ChangeRequest.find({ requestedBy: req.user._id })
    .populate('assignedTo', USER_FIELDS)
    .populate('decidedBy', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: changeRequests.length, changeRequests });
});

// Who has a change-request inbox at all. Exported because the approvals badge
// count (approvalController.countHrApprovals) has to gate its ChangeRequest
// tally on exactly this audience — a second copy of the list would drift.
const CHANGE_INBOX_ROLES = ['HRManager', 'SuperAdmin', 'CEO', 'MD'];

/**
 * The admin's change-request inbox — HR partners see employee requests routed to
 * them; CEO/MD see HR requests routed to them; a SuperAdmin can see all (?all).
 * @route GET /api/change-requests/assigned
 */
const assignedChangeRequests = asyncHandler(async (req, res) => {
  if (!CHANGE_INBOX_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error('You do not have a change-request inbox');
  }
  const filter =
    req.user.role === 'SuperAdmin' && req.query.all === 'true'
      ? {}
      : { assignedTo: req.user._id };

  const changeRequests = await ChangeRequest.find(filter)
    .populate('requestedBy', USER_FIELDS)
    .populate('targetUser', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .populate('decidedBy', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: changeRequests.length, changeRequests });
});

/**
 * Approve (applying the value to the target's record) or decline a pending
 * request. The assigned approver or a SuperAdmin may decide.
 * @route PATCH /api/change-requests/:id  { action, appliedValue, decisionNote }
 */
const decideChangeRequest = asyncHandler(async (req, res) => {
  const cr = await ChangeRequest.findById(req.params.id);
  if (!cr) {
    res.status(404);
    throw new Error('Change request not found');
  }
  const isAssignee = cr.assignedTo && cr.assignedTo.equals(req.user._id);
  if (!isAssignee && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only the assigned approver or a SuperAdmin can decide this request');
  }
  if (cr.status !== 'pending') {
    res.status(400);
    throw new Error('This request has already been decided');
  }

  const { action, appliedValue, decisionNote } = req.body;
  if (!['approve', 'decline'].includes(action)) {
    res.status(400);
    throw new Error("action must be 'approve' or 'decline'");
  }

  const meta = FIELD_CATALOG[cr.field];
  const target = cr.targetUser || cr.requestedBy;

  if (action === 'approve') {
    const valueToApply =
      appliedValue !== undefined && String(appliedValue).trim() !== ''
        ? String(appliedValue).trim()
        : cr.requestedValue;
    const before = meta.secret ? '' : await readFieldValue(target, meta);
    await applyFieldValue(target, meta, valueToApply);
    auditFieldChange(req.user, meta, before, valueToApply, await auditTargetOf(target));
    cr.status = 'approved';
    cr.appliedValue = meta.secret ? '••••••' : valueToApply;
  } else {
    cr.status = 'declined';
  }

  cr.decisionNote = decisionNote ? String(decisionNote).trim() : undefined;
  cr.decidedBy = req.user._id;
  cr.decidedAt = new Date();
  await cr.save();

  // Tell the requester, and the employee if HR raised it on their behalf.
  const recipients = new Set([String(cr.requestedBy)]);
  if (cr.targetUser) recipients.add(String(cr.targetUser));
  await Promise.all([...recipients].map((recipient) =>
    Notification.create({
      recipient,
      type: 'change_request',
      title: `Change request ${cr.status}`,
      body: `The change to "${cr.fieldLabel}" was ${cr.status}.`,
      link: 'change-requests',
    })
  ));

  res.json({ changeRequest: cr });
});

module.exports = {
  getFields,
  fillMissingField,
  createChangeRequest,
  createAdminChangeRequest,
  queueAdminChange,
  myChangeRequests,
  assignedChangeRequests,
  decideChangeRequest,
  CHANGE_INBOX_ROLES,
};
