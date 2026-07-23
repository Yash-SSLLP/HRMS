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

const USER_FIELDS = 'firstName lastName email role';

// A complaint is confidential to the leadership group — the CEO, HR Managers and
// SuperAdmins — EXCEPT the person it's raised against (they never see it).
const COMPLAINT_VIEWER_ROLES = ['SuperAdmin', 'HRManager', 'CEO'];

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
 * @sideeffect notifies leadership (CEO/HR/SuperAdmin) except the accused and complainant, with no sensitive detail
 */
// POST /api/complaints  { againstUserId, subject, description }
// Routing:
//  - Complaint about an HRManager/SuperAdmin  -> escalate to a SuperAdmin.
//  - Complaint about the complainant's own HR partner -> escalate to a SuperAdmin.
//  - Complaint about a fellow Employee -> the complainant's assigned HR partner
//    (falling back to a SuperAdmin if they have none).
const createComplaint = asyncHandler(async (req, res) => {
  const meId = req.user._id;
  const { againstUserId, subject, description } = req.body;

  if (!againstUserId || !subject || !description) {
    res.status(400);
    throw new Error('againstUserId, subject and description are required');
  }
  if (String(againstUserId) === String(meId)) {
    res.status(400);
    throw new Error('You cannot raise a complaint against yourself');
  }

  const against = await User.findById(againstUserId).select(USER_FIELDS);
  if (!against) {
    res.status(404);
    throw new Error('The person you are complaining about was not found');
  }

  const myProfile = await EmployeeProfile.findOne({ user: meId }).select('hrPartner');
  const myHrPartnerId = myProfile?.hrPartner ? String(myProfile.hrPartner) : null;

  // Escalate to a SuperAdmin when the complaint targets an admin or the caller's own HR
  const aboutAdmin = ['HRManager', 'SuperAdmin'].includes(against.role);
  const aboutMyHr = myHrPartnerId && myHrPartnerId === String(againstUserId);

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
    against: againstUserId,
    subject,
    description,
    assignedTo,
  });

  // Alert the leadership group — CEO, HR and SuperAdmin — but NEVER the person
  // the complaint is about (nor the complainant). Kept deliberately vague (no
  // names/subject) so nothing sensitive leaks into a push/lock-screen preview.
  const viewers = await User.find({ role: { $in: COMPLAINT_VIEWER_ROLES }, isActive: true }).select('_id').lean();
  const recipients = viewers
    .map((u) => String(u._id))
    .filter((id) => id !== String(againstUserId) && id !== String(meId));
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
 * @route GET /api/complaints/assigned  (CEO / HR / SuperAdmin)
 * @returns {{count: number, complaints: Object[]}} with populated complainant/against/assignedTo
 */
// GET /api/complaints/assigned  — leadership inbox (CEO / HR / SuperAdmin)
// Everyone in the group sees every complaint EXCEPT ones raised against them.
const assignedComplaints = asyncHandler(async (req, res) => {
  // Permission gate: only leadership roles have an inbox
  if (!COMPLAINT_VIEWER_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error('Only the CEO, HR and SuperAdmins can view complaints');
  }
  const filter = { against: { $ne: req.user._id } };

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
  // the CEO has read-only visibility, so they can view but not update.
  const canManage = ['SuperAdmin', 'HRManager'].includes(req.user.role) && !complaint.against.equals(req.user._id);
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

module.exports = { createComplaint, myComplaints, assignedComplaints, updateComplaint };
