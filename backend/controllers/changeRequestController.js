const asyncHandler = require('express-async-handler');
const ChangeRequest = require('../models/ChangeRequest');
const { CHANGE_REQUEST_STATUSES, FIELD_CATALOG } = require('../models/ChangeRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Notification = require('../models/Notification');

const USER_FIELDS = 'firstName lastName email role';

async function findSuperAdmin() {
  return User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 });
}

// Read a dot-path value off a Mongoose doc / plain object.
function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// Stringify a value for display/snapshot. Date fields render as YYYY-MM-DD.
function fmtVal(meta, val) {
  if (val == null) return '';
  if (meta.type === 'date') {
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? String(val) : d.toISOString().slice(0, 10);
  }
  return String(val);
}

// The admin who should decide this user's requests: their HR partner, else a
// SuperAdmin. Mirrors the complaint-routing convention.
async function resolveAssignee(userId) {
  const profile = await EmployeeProfile.findOne({ user: userId }).select('hrPartner');
  if (profile?.hrPartner) return profile.hrPartner;
  const sa = await findSuperAdmin();
  return sa?._id;
}

// GET /api/change-requests/fields
// The catalogue plus the caller's current values, so the UI can show what each
// field is today and let them pick one to change. Secret fields show no value.
const getFields = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('email firstName lastName phone');
  const profile = await EmployeeProfile.findOne({ user: req.user._id }).lean();

  const fields = Object.entries(FIELD_CATALOG).map(([key, meta]) => {
    let current = '';
    if (!meta.secret) {
      const source = meta.model === 'User' ? user : profile;
      const val = source ? getPath(source, meta.path) : undefined;
      current = fmtVal(meta, val);
    }
    return {
      key,
      label: meta.label,
      secret: !!meta.secret,
      type: meta.type || (meta.secret ? 'password' : 'text'),
      currentValue: current,
    };
  });

  res.json({ fields });
});

// POST /api/change-requests  { field, requestedValue, reason }
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

  // Snapshot the current value (never for secret fields).
  let currentValue = '';
  if (!meta.secret) {
    if (meta.model === 'User') {
      const user = await User.findById(req.user._id).select(meta.path);
      currentValue = getPath(user, meta.path);
    } else {
      const profile = await EmployeeProfile.findOne({ user: req.user._id }).lean();
      currentValue = profile ? getPath(profile, meta.path) : '';
    }
    currentValue = fmtVal(meta, currentValue);
  }

  const assignedTo = await resolveAssignee(req.user._id);

  const cr = await ChangeRequest.create({
    requestedBy: req.user._id,
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
      title: 'New change request',
      body: `${req.user.firstName} ${req.user.lastName} requested a change to "${meta.label}".`,
      link: 'change-requests',
    });
  }

  res.status(201).json({ changeRequest: cr });
});

// GET /api/change-requests/mine
const myChangeRequests = asyncHandler(async (req, res) => {
  const changeRequests = await ChangeRequest.find({ requestedBy: req.user._id })
    .populate('assignedTo', USER_FIELDS)
    .populate('decidedBy', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: changeRequests.length, changeRequests });
});

// GET /api/change-requests/assigned  (HR/SuperAdmin; ?all=true for SuperAdmin)
const assignedChangeRequests = asyncHandler(async (req, res) => {
  if (!['HRManager', 'SuperAdmin'].includes(req.user.role)) {
    res.status(403);
    throw new Error('Only HR Managers and SuperAdmins have a change-request inbox');
  }
  const filter =
    req.user.role === 'SuperAdmin' && req.query.all === 'true'
      ? {}
      : { assignedTo: req.user._id };

  const changeRequests = await ChangeRequest.find(filter)
    .populate('requestedBy', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .populate('decidedBy', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: changeRequests.length, changeRequests });
});

// Apply an approved value to the underlying User / EmployeeProfile document.
// Runs schema validators (email format, IFSC, PAN, etc.) via save().
async function applyChange(requestedByUserId, meta, value) {
  if (meta.model === 'User') {
    const user = await User.findById(requestedByUserId).select('+password');
    if (!user) throw Object.assign(new Error('Target user no longer exists'), { status: 404 });
    if (meta.path === 'email') {
      const email = String(value).toLowerCase().trim();
      const clash = await User.findOne({ email, _id: { $ne: user._id } });
      if (clash) throw Object.assign(new Error('That email is already in use'), { status: 409 });
      user.email = email;
    } else {
      user.set(meta.path, value); // password set here is re-hashed by the pre-save hook
    }
    await user.save();
  } else {
    const profile = await EmployeeProfile.findOne({ user: requestedByUserId });
    if (!profile) throw Object.assign(new Error('Employee profile not found'), { status: 404 });
    profile.set(meta.path, value);
    await profile.save();
  }
}

// PATCH /api/change-requests/:id  { action: 'approve'|'decline', appliedValue, decisionNote }
const decideChangeRequest = asyncHandler(async (req, res) => {
  const cr = await ChangeRequest.findById(req.params.id);
  if (!cr) {
    res.status(404);
    throw new Error('Change request not found');
  }

  const isAssignee = cr.assignedTo && cr.assignedTo.equals(req.user._id);
  if (!isAssignee && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only the assigned admin or a SuperAdmin can decide this request');
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

  if (action === 'approve') {
    // Admin may override the value the employee asked for.
    const valueToApply =
      appliedValue !== undefined && String(appliedValue).trim() !== ''
        ? String(appliedValue).trim()
        : cr.requestedValue;

    await applyChange(cr.requestedBy, meta, valueToApply);

    cr.status = 'approved';
    cr.appliedValue = meta.secret ? '••••••' : valueToApply;
  } else {
    cr.status = 'declined';
  }

  cr.decisionNote = decisionNote ? String(decisionNote).trim() : undefined;
  cr.decidedBy = req.user._id;
  cr.decidedAt = new Date();
  await cr.save();

  await Notification.create({
    recipient: cr.requestedBy,
    type: 'change_request',
    title: `Change request ${cr.status}`,
    body: `Your request to change "${cr.fieldLabel}" was ${cr.status}.`,
    link: 'change-requests',
  });

  res.json({ changeRequest: cr });
});

module.exports = {
  getFields,
  createChangeRequest,
  myChangeRequests,
  assignedChangeRequests,
  decideChangeRequest,
};
module.exports._statuses = CHANGE_REQUEST_STATUSES;
