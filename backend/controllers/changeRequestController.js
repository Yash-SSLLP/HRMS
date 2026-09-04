/**
 * Change-request controller. Three ways a whitelisted profile/credential field
 * (FIELD_CATALOG) gets changed:
 *   • Employee fills a MISSING field  → applied immediately (audited), then locked.
 *   • Employee changes a FILLED field → request routed to their HR partner,
 *     EXCEPT for an HR Manager / Manager changing a personal-and-contact field
 *     about themselves, which applies immediately (audited) — see
 *     selfEditsDirectly in models/ChangeRequest.js for why.
 *   • HR changes an employee's field  → request routed to the company CEO/MD.
 * The Backend (SuperAdmin) edits directly elsewhere; it never raises a request.
 * Secret fields (password) never snapshot or echo their value.
 */
const asyncHandler = require('express-async-handler');
const ChangeRequest = require('../models/ChangeRequest');
const { FIELD_CATALOG, selfEditsDirectly, isSelfDirectField } = require('../models/ChangeRequest');
const SelfEditLog = require('../models/SelfEditLog');
const { ymdIST } = require('../utils/dateHelpers');
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
  claimDailySelfEdit,
  releaseDailySelfEdit,
} = require('../services/profileChanges');

const USER_FIELDS = 'firstName lastName email role';

/**
 * A change request as it may leave the server.
 *
 * `password` used to be a catalogue field, so historical rows hold the new
 * password in `requestedValue` exactly as it was typed. Every client already
 * masks it on screen — but masking on DISPLAY does nothing about the value
 * sitting in the JSON, which is visible in devtools, in any proxy or crash
 * report, and in the SuperAdmin inbox where `?all=true` filters on `{}` and so
 * returns every row in the collection at once.
 *
 * So it is redacted HERE, on the way out, for every reader. This is belt and
 * braces on top of scripts/scrubPasswordChangeRequests.js, which destroys the
 * stored values: the scrub is the fix, and this makes a row that was missed —
 * or restored from an old backup — harmless anyway.
 *
 * Keyed on the field name rather than on FIELD_CATALOG, precisely because
 * `password` is no longer IN the catalogue and a metadata lookup would come back
 * undefined and redact nothing.
 * @param {object} cr - a ChangeRequest document or lean object
 * @returns {object} safe to serialise
 */
function publicChangeRequest(cr) {
  const o = typeof cr?.toObject === 'function' ? cr.toObject() : { ...cr };
  if (o.field === 'password') {
    if (o.requestedValue) o.requestedValue = '••••••';
    if (o.appliedValue) o.appliedValue = '••••••';
    if (o.currentValue) o.currentValue = '••••••';
  }
  return o;
}

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
  // Read the whole of today's spend in ONE query and pass a Set into the loop
  // below. The loop already awaits per field; a lookup inside it would add a
  // round-trip per catalogue entry on every page load.
  const spentToday = new Set(
    (await SelfEditLog.find({ user: req.user._id, day: ymdIST() }).select('field').lean())
      .map((r) => r.field)
  );
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
      // True when changing this field will apply straight away rather than ask
      // someone. The UI reads it so it never promises an approval step that is
      // not going to happen: uncapped for HR/Manager, and for everybody else
      // only while today's once-a-day allowance for THIS field is unspent.
      direct: selfEditsDirectly(req.user, key)
        || (isSelfDirectField(key, req.user) && !spentToday.has(key)),
      // Already used today, so the next change of it goes to HR. Distinct from
      // `direct: false` on a field nobody may self-edit at all (bank, PAN), so
      // the UI can say "you have already changed this today" rather than the
      // flatly wrong "this always needs approval".
      spentToday: isSelfDirectField(key, req.user) && spentToday.has(key),
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

  const newVal = String(requestedValue).trim();

  // Re-submitting the value already on record is a no-op. Worth catching before
  // anything else: it would otherwise spend the day's allowance on a change that
  // changes nothing, or — once the allowance is gone — put a request in HR's
  // inbox asking them to approve the value they are already looking at.
  if (!meta.secret && String(currentValue ?? '') === newVal) {
    return res.status(200).json({ applied: true, unchanged: true, field, value: currentValue });
  }

  // Changing your own contact or life-event details applies immediately rather
  // than asking anyone. Two tiers:
  //   - HR Managers and Managers: unlimited (see selfEditsDirectly for why —
  //     their approver is the Backend, so a queued edit has nobody local to
  //     decide it);
  //   - everyone else: once per IST day per field. The day's second change of
  //     the same field falls through to the ordinary request below, which is the
  //     point of the rule — a detail can be corrected, not churned.
  // A designation or a bank account is in neither tier: those always go to
  // approval, however senior the person asking.
  if (isSelfDirectField(field, req.user)) {
    const uncapped = selfEditsDirectly(req.user, field);
    const claimed = uncapped || await claimDailySelfEdit(req.user._id, field);
    if (claimed) {
      try {
        await applyFieldValue(req.user._id, meta, newVal);
      } catch (err) {
        // The value was refused (a gender or marital-status enum, say). Give the
        // day back — the employee has not spent their change on a failure.
        if (!uncapped) await releaseDailySelfEdit(req.user._id, field);
        throw err;
      }
      auditFieldChange(req.user, meta, currentValue, newVal, await auditTargetOf(req.user._id));
      return res.status(200).json({
        applied: true,
        field,
        value: await readFieldValue(req.user._id, meta),
      });
    }
    // Allowance spent — fall through and raise a request, exactly as a field
    // nobody may self-edit would.
  }

  const assignedTo = await resolveHrAssignee(req.user._id);

  const cr = await ChangeRequest.create({
    requestedBy: req.user._id,
    targetUser: req.user._id,
    approverKind: 'hr',
    assignedTo,
    field,
    fieldLabel: meta.label,
    currentValue,
    requestedValue: newVal,
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
  res.json({ count: changeRequests.length, changeRequests: changeRequests.map(publicChangeRequest) });
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
  let filter =
    req.user.role === 'SuperAdmin' && req.query.all === 'true'
      ? {}
      : { assignedTo: req.user._id };

  // An HR Manager also sees the WAITING requests of everyone they now partner,
  // whoever they were assigned to at the time. Requests raised before an HR
  // partner existed are assigned to the Backend account (resolveHrAssignee), so
  // without this they would stay invisible to the HR who has since taken the
  // employee on — the request is theirs to answer, and the employee is waiting.
  if (req.user.role === 'HRManager') {
    const mine = await EmployeeProfile.find({ hrPartner: req.user._id }).select('user').lean();
    const userIds = mine.map((p) => p.user).filter(Boolean);
    if (userIds.length) {
      filter = {
        $or: [
          { assignedTo: req.user._id },
          { approverKind: 'hr', status: 'pending', targetUser: { $in: userIds } },
        ],
      };
    }
  }

  const changeRequests = await ChangeRequest.find(filter)
    .populate('requestedBy', USER_FIELDS)
    .populate('targetUser', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .populate('decidedBy', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: changeRequests.length, changeRequests: changeRequests.map(publicChangeRequest) });
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
  // …and the employee's CURRENT HR partner, for a request that was assigned
  // elsewhere because nobody was their partner when they raised it. Seeing it in
  // the inbox without being able to answer it would be worse than not seeing it.
  let isTheirHrPartner = false;
  if (!isAssignee && cr.approverKind === 'hr' && cr.targetUser) {
    const target = await EmployeeProfile.findOne({ user: cr.targetUser }).select('hrPartner').lean();
    isTheirHrPartner = String(target?.hrPartner || '') === String(req.user._id);
  }
  if (!isAssignee && !isTheirHrPartner && req.user.role !== 'SuperAdmin') {
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

  // A row whose field has since been retired from the catalogue - `password` is
  // the one that has - has no meta to apply through. It can still be DECLINED,
  // so a queue full of them can be cleared; it can never be approved, because
  // there is nothing left to write it to.
  if (!meta) {
    if (action === 'approve') {
      res.status(410);
      throw new Error(`"${cr.fieldLabel || cr.field}" is no longer changed this way, so this request cannot be approved. Decline it — the person can make the change themselves.`);
    }
    cr.status = 'declined';
    cr.decisionNote = decisionNote ? String(decisionNote).trim() : undefined;
    cr.decidedBy = req.user._id;
    cr.decidedAt = new Date();
    // Retired secret fields (password) must not leave their value behind.
    cr.requestedValue = '••••••';
    await cr.save();
    return res.json({ changeRequest: publicChangeRequest(cr) });
  }

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

  res.json({ changeRequest: publicChangeRequest(cr) });
});

/**
 * Hand an employee's WAITING change requests to their new HR partner.
 *
 * A request raised while nobody was their partner is assigned to the Backend
 * account (resolveHrAssignee), which is a safe place to park it but not a place
 * the incoming HR will ever look. Assigning the partner is the moment it becomes
 * theirs, so the request moves with the employee and the new owner is told —
 * otherwise it waits in an inbox nobody is watching on that employee's behalf.
 *
 * Only PENDING, HR-decided requests move: a decided one is history, and an
 * exec-decided one (an HR-raised change) belongs to the CEO/MD, not to HR.
 *
 * @param {string|import('mongoose').Types.ObjectId} targetUser - the employee's User id
 * @param {string|import('mongoose').Types.ObjectId} hrPartner - their new HR partner's User id
 * @returns {Promise<number>} how many requests moved
 * @sideeffect Notifies the new partner once, however many moved.
 */
async function reassignPendingHrRequests(targetUser, hrPartner) {
  if (!targetUser || !hrPartner) return 0;
  const res = await ChangeRequest.updateMany(
    {
      targetUser,
      approverKind: 'hr',
      status: 'pending',
      assignedTo: { $ne: hrPartner },
    },
    { $set: { assignedTo: hrPartner } }
  );
  const moved = res.modifiedCount || 0;
  if (moved) {
    const who = await User.findById(targetUser).select('firstName lastName').lean();
    const name = `${who?.firstName || ''} ${who?.lastName || ''}`.trim() || 'An employee';
    await Notification.create({
      recipient: hrPartner,
      type: 'change_request',
      audience: 'admin',
      title: moved === 1 ? 'A change request is now yours' : `${moved} change requests are now yours`,
      body: `${name} is now yours to look after, and ${moved === 1 ? 'a request they raised is' : `${moved} requests they raised are`} still waiting for a decision.`,
      link: 'change-requests',
    });
  }
  return moved;
}

module.exports = {
  getFields,
  fillMissingField,
  createChangeRequest,
  createAdminChangeRequest,
  queueAdminChange,
  myChangeRequests,
  assignedChangeRequests,
  decideChangeRequest,
  reassignPendingHrRequests,
  CHANGE_INBOX_ROLES,
};
