const asyncHandler = require('express-async-handler');
const Complaint = require('../models/Complaint');
const { COMPLAINT_STATUSES } = require('../models/Complaint');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');

const USER_FIELDS = 'firstName lastName email role';

async function findSuperAdmin() {
  return User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 });
}

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

  res.status(201).json({ complaint });
});

// GET /api/complaints/mine  — complaints the caller raised
const myComplaints = asyncHandler(async (req, res) => {
  const complaints = await Complaint.find({ complainant: req.user._id })
    .populate('against', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: complaints.length, complaints });
});

// GET /api/complaints/assigned  — handler inbox (HR/SuperAdmin)
// SuperAdmin may pass ?all=true to see every complaint.
const assignedComplaints = asyncHandler(async (req, res) => {
  if (!['HRManager', 'SuperAdmin'].includes(req.user.role)) {
    res.status(403);
    throw new Error('Only HR Managers and SuperAdmins have a complaints inbox');
  }
  const filter =
    req.user.role === 'SuperAdmin' && req.query.all === 'true'
      ? {}
      : { assignedTo: req.user._id };

  const complaints = await Complaint.find(filter)
    .populate('complainant', USER_FIELDS)
    .populate('against', USER_FIELDS)
    .populate('assignedTo', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: complaints.length, complaints });
});

// PATCH /api/complaints/:id  { status, resolutionNote }
const updateComplaint = asyncHandler(async (req, res) => {
  const complaint = await Complaint.findById(req.params.id);
  if (!complaint) {
    res.status(404);
    throw new Error('Complaint not found');
  }

  const isAssignee = complaint.assignedTo && complaint.assignedTo.equals(req.user._id);
  if (!isAssignee && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only the assigned handler or a SuperAdmin can update this complaint');
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
