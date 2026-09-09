/**
 * Complaint controller — confidential grievances. Employees raise complaints
 * against a colleague; each is routed to an HR partner or SuperAdmin (escalated
 * when it concerns an admin or the complainant's own HR). Only leadership (CEO/HR/
 * SuperAdmin) can view them, and never the person a complaint is raised against.
 */
const asyncHandler = require('express-async-handler');
const Complaint = require('../models/Complaint');
const { COMPLAINT_STATUSES } = require('../models/Complaint');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');
const { isEditingExec } = require('../middleware/authMiddleware');
// Company wall: Complaint.complainant refs User, so the User-keyed helper applies.
const { scopeUserField } = require('../utils/employeeScope');

const USER_FIELDS = 'firstName lastName email role';

// A complaint is confidential to the leadership group — the CEO and MD, HR
// Managers and SuperAdmins — EXCEPT the person it's raised against (they never
// see it). MD belongs here for the same reason CEO does: the two are one
// executive tier everywhere else in the app (EXEC_VIEWERS in authMiddleware,
// EXECUTIVE_ROLES in utils/visibility), and leaving MD out both 403'd their
// inbox and dropped them from the new-complaint alert.
const COMPLAINT_VIEWER_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD'];

// The two CLOSED states — the only ones a complaint may be deleted from.
// 'resolved' was closed with action, 'dismissed' closed without: both are a
// verdict that has already been delivered, which is what makes the record safe
// to clear. 'open' and 'under_review' are somebody's live grievance and are
// never deletable — see deleteComplaint.
const COMPLAINT_CLOSED_STATUSES = ['resolved', 'dismissed'];

async function findSuperAdmin() {
  return User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 });
}

/**
 * Raise a confidential complaint against another user; auto-routes the assignee.
 * @route POST /api/complaints
 * @param {string} req.body.againstUserId - required; cannot be self
 * @param {string} req.body.subject - required
 * @param {string} req.body.description - required
 * @returns {{complaint: Object}} (201)
 * @sideeffect notifies leadership (CEO/MD/HR/SuperAdmin) except the accused and complainant, with no sensitive detail
 */
// POST /api/complaints  { againstUserId, subject, description }
//
// `againstUserId` is either a User id or the literal string 'general'
// (Complaint.GENERAL_TARGET) meaning "about the workplace, not about a person".
// One field on the wire rather than two keeps both clients — the web picker and
// the mobile picker — sending exactly what they sent before, with one extra
// option in the list.
//
// Routing:
//  - Complaint about an HRManager/SuperAdmin  -> escalate to a SuperAdmin.
//  - Complaint about the complainant's own HR partner -> escalate to a SuperAdmin.
//  - Complaint about a fellow Employee, or a GENERAL complaint -> the
//    complainant's assigned HR partner (falling back to a SuperAdmin if they
//    have none). A general grievance names nobody, so there is nobody to
//    escalate away from; it takes the ordinary path.
const createComplaint = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { againstUserId, subject, description } = req.body;

  if (!againstUserId || !subject || !description) {
    res.status(400);
    throw new Error('againstUserId, subject and description are required');
  }

  const isGeneral = String(againstUserId) === Complaint.GENERAL_TARGET;

  if (!isGeneral && String(againstUserId) === String(meId)) {
    res.status(400);
    throw new Error('You cannot raise a complaint against yourself');
  }

  // A general complaint has no target to look up, so the 404 below — and the
  // role read that follows it — are both skipped rather than guarded one by one.
  let against = null;
  if (!isGeneral) {
    against = await User.findById(againstUserId).select(USER_FIELDS);
    if (!against) {
      res.status(404);
      throw new Error('The person you are complaining about was not found');
    }
  }

  const myProfile = await EmployeeProfile.findOne({ user: meId }).select('hrPartner');
  const myHrPartnerId = myProfile?.hrPartner ? String(myProfile.hrPartner) : null;

  // Escalate to a SuperAdmin when the complaint targets an admin or the caller's own HR
  const aboutAdmin = !isGeneral && ['HRManager', 'SuperAdmin'].includes(against.role);
  const aboutMyHr = !isGeneral && myHrPartnerId && myHrPartnerId === String(againstUserId);

  let assignedTo;
  if (aboutAdmin || aboutMyHr) {
    const sa = await findSuperAdmin();
    assignedTo = sa?._id;
  } else if (myHrPartnerId) {
    assignedTo = myProfile.hrPartner;
  } else {
    const sa = await findSuperAdmin();
    assignedTo = sa?._id;
  }

  const complaint = await Complaint.create({
    complainant: meId,
    againstType: isGeneral ? 'General' : 'Person',
    against: isGeneral ? undefined : againstUserId,
    subject,
    description,
    assignedTo,
  });

  // Alert the leadership group — CEO/MD, HR and SuperAdmin — but NEVER the person
  // the complaint is about (nor the complainant). Kept deliberately vague (no
  // names/subject) so nothing sensitive leaks into a push/lock-screen preview.
  // A general complaint names nobody, so only the complainant is held back —
  // comparing against the literal 'general' would exclude no one anyway, but
  // saying so explicitly stops the next reader wondering.
  const viewers = await User.find({ role: { $in: COMPLAINT_VIEWER_ROLES }, isActive: true }).select('_id').lean();
  const accusedId = isGeneral ? null : String(againstUserId);
  const recipients = viewers
    .map((u) => String(u._id))
    .filter((id) => id !== accusedId && id !== String(meId));
  notifyMany(recipients, {
    type: 'complaint',
    audience: 'admin',
    title: '⚠ New complaint to review',
    body: 'A confidential complaint has been raised. Open the Complaints inbox to review it.',
    link: '/admin/complaints',
  }).catch(() => {});

  res.status(201).json({ complaint });
});

/**
 * List complaints raised by the caller, newest first.
 * @route GET /api/complaints/mine
 * @returns {{count: number, complaints: Object[]}} with populated against/assignedTo
 */
// GET /api/complaints/mine  — complaints the caller raised
const myComplaints = asyncHandler(async (req, res) => {
  const complaints = await Complaint.find({ complainant: req.user._id })
    .populate('against', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: complaints.length, complaints });
});

/**
 * Leadership inbox: all complaints except ones raised against the viewer.
 * @route GET /api/complaints/assigned  (CEO / MD / HR / SuperAdmin)
 * @returns {{count: number, complaints: Object[]}} with populated complainant/against/assignedTo
 */
// GET /api/complaints/assigned  — leadership inbox (CEO / MD / HR / SuperAdmin)
// Everyone in the group sees every complaint EXCEPT ones raised against them.
const assignedComplaints = asyncHandler(async (req, res) => {
  // Permission gate: only leadership roles have an inbox
  if (!COMPLAINT_VIEWER_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error('Only the CEO/MD, HR and SuperAdmins can view complaints');
  }
  // `$ne` also matches documents where the field is ABSENT, so a General
  // complaint (which has no `against` at all) is visible to the whole
  // leadership group — correct, since it accuses none of them.
  const filter = { against: { $ne: req.user._id } };
  // Company wall: a walled leader only sees complaints raised by their own
  // company's people. The never-see-your-own-accusations rule above still holds.
  await scopeUserField(req, filter, 'complainant');

  const complaints = await Complaint.find(filter)
    .populate('complainant', USER_FIELDS)
    .populate('against', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: complaints.length, complaints });
});

/**
 * Update a complaint's status/resolution note.
 * @route PATCH /api/complaints/:id
 * @param {string} req.params.id - complaint id
 * @param {string} [req.body.status] - one of COMPLAINT_STATUSES
 * @param {string} [req.body.resolutionNote]
 * @returns {{complaint: Object}}; HR/SuperAdmin (not the accused) or the assignee only; CEO is read-only
 */
// PATCH /api/complaints/:id  { status, resolutionNote }
const updateComplaint = asyncHandler(async (req, res) => {
  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) {
    res.status(404);
    throw new Error('Complaint not found');
  }

  // HR and SuperAdmin can action any complaint (except one against themselves);
  // the CEO has read-only visibility, so they can view but not update — unless a
  // SuperAdmin has switched that exec account into edit mode.
  // `against?.` — a General complaint has no target, and an unguarded
  // `.equals()` on it would 500 every attempt to action one. No target also
  // means nobody in the leadership group is the accused, so the rule this
  // clause enforces ("never action a complaint about yourself") simply does not
  // bite: undefined -> !undefined -> allowed, which is the right answer.
  const canManage = (['SuperAdmin', 'HRManager'].includes(req.user.role) || isEditingExec(req.user))
    && !complaint.against?.equals(req.user._id);
  const isAssignee = complaint.assignedTo && complaint.assignedTo.equals(req.user._id);
  if (!canManage && !isAssignee) {
    res.status(403);
    throw new Error('You are not allowed to update this complaint');
  }

  const { status, resolutionNote } = req.body;
  if (status !== undefined) {
    if (!COMPLAINT_STATUSES.includes(status)) {
      res.status(400);
      throw new Error(`status must be one of ${COMPLAINT_STATUSES.join(', ')}`);
    }
    complaint.status = status;
  }
  if (resolutionNote !== undefined) complaint.resolutionNote = resolutionNote;

  await complaint.save();
  res.json({ complaint });
});

/**
 * Permanently delete a CLOSED complaint (resolved or dismissed).
 * @route DELETE /api/complaints/:id  (SuperAdmin / HR Manager / CEO / MD)
 * @param {string} req.params.id - complaint id
 * @returns {{ok: true, id: string}}
 */
// DELETE /api/complaints/:id
//
// The leadership inbox is a permanent record of every grievance ever filed, and
// it never emptied — the seven test complaints raised while the module was being
// built sit at the top of it forever, above the real ones. This is the way to
// clear a closed case.
//
// THREE GATES, and each is doing its own job:
//
//  1. ROLE — the same COMPLAINT_VIEWER_ROLES that can read the inbox. Nobody
//     outside leadership can delete something they cannot even see.
//  2. STATUS — CLOSED only (resolved or dismissed). An open or under-review
//     complaint is somebody's live grievance, and deleting one would let an
//     inconvenient accusation disappear before it was answered. Closing it
//     first — either way — is a deliberate, audited step that has to happen in
//     the open, and the audit line records WHICH closed state it went from.
//  3. NOT THE ACCUSED — `against?.equals`, the same rule updateComplaint uses.
//     An HR Manager or an exec may not delete the complaint filed about THEM.
//     Without this the gate above is worthless: the accused could resolve their
//     own case and then erase it. (`?.` because a General complaint has no
//     target — see createComplaint.)
//
// A view-only account never reaches here at all: `protect` refuses every unsafe
// method for one, and DELETE is unsafe.
//
// The row is gone, so the audit line is the only thing left that says it existed
// — it is written BEFORE the delete and awaited, unlike the best-effort audit
// writes elsewhere in the app, because there is no recovering the record if it
// fails.
const deleteComplaint = asyncHandler(async (req, res) => {
  if (!COMPLAINT_VIEWER_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error('Only the CEO/MD, HR and SuperAdmins can delete complaints');
  }

  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) {
    res.status(404);
    throw new Error('Complaint not found');
  }
  if (!COMPLAINT_CLOSED_STATUSES.includes(complaint.status)) {
    res.status(400);
    throw new Error('Only a closed complaint can be deleted. Resolve or dismiss it first.');
  }
  if (complaint.against?.equals(req.user._id)) {
    res.status(403);
    throw new Error('You cannot delete a complaint raised against you');
  }

  const AuditLog = require('../models/AuditLog');
  await AuditLog.create({
    entity: 'Complaint',
    entityId: complaint._id,
    entityLabel: complaint.subject,
    field: 'status',
    fromStatus: complaint.status,
    toStatus: 'deleted',
    by: req.user._id,
    byName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    byRole: req.user.role,
  });

  await complaint.deleteOne();
  res.json({ ok: true, id: req.params.id });
});

module.exports = { createComplaint, myComplaints, assignedComplaints, updateComplaint, deleteComplaint };
