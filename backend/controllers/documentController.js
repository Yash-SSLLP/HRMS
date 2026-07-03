const asyncHandler = require('express-async-handler');
const path = require('path');
const Document = require('../models/Document');
const {
  SELF_UPLOAD_CATEGORIES,
  ALL_CATEGORIES,
  HR_ONLY_CATEGORIES,
  PII_CATEGORIES,
  REQUIRED_DOCUMENT_CATEGORIES,
} = require('../models/Document');
const EmployeeProfile = require('../models/EmployeeProfile');
const storage = require('../services/storage');

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

function isAdmin(user) {
  return user.role === 'SuperAdmin' || user.role === 'HRManager';
}

// ===== Employee =====

// GET /api/documents/me
const listMine = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const docs = await Document.find({ employee: profile._id }).sort({ createdAt: -1 });
  res.json({ count: docs.length, documents: docs });
});

// POST /api/documents/me  (multipart: file + category)
const uploadMine = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('File is required (multipart field "file")');
  }
  const { category, note } = req.body;
  if (!SELF_UPLOAD_CATEGORIES.includes(category)) {
    res.status(400);
    throw new Error(`Employees may upload only: ${SELF_UPLOAD_CATEGORIES.join(', ')}`);
  }
  const profile = await getMyProfileOrFail(req.user._id, res);

  const { storagePath, sha256, sizeBytes } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'employee',
    ownerId: profile._id,
    originalName: req.file.originalname,
  });

  const doc = await Document.create({
    employee: profile._id,
    category,
    fileName: req.file.originalname,
    storagePath,
    mime: req.file.mimetype,
    sizeBytes,
    sha256,
    isPii: PII_CATEGORIES.includes(category),
    uploadedBy: req.user._id,
    note,
  });
  res.status(201).json({ document: doc });
});

// ===== HR/Admin =====

// GET /api/documents?employee=
const listForEmployee = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  const docs = await Document.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ createdAt: -1 });
  res.json({ count: docs.length, documents: docs });
});

// POST /api/documents  (HR uploads on behalf)  multipart: file + employee + category
const uploadForEmployee = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('File is required (multipart field "file")');
  }
  const { employee, category, note } = req.body;
  if (!employee || !category) {
    res.status(400);
    throw new Error('employee and category are required');
  }
  if (!ALL_CATEGORIES.includes(category)) {
    res.status(400);
    throw new Error(`Invalid category. Allowed: ${ALL_CATEGORIES.join(', ')}`);
  }
  const profile = await EmployeeProfile.findById(employee);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }

  const { storagePath, sha256, sizeBytes } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'employee',
    ownerId: profile._id,
    originalName: req.file.originalname,
  });

  const doc = await Document.create({
    employee: profile._id,
    category,
    fileName: req.file.originalname,
    storagePath,
    mime: req.file.mimetype,
    sizeBytes,
    sha256,
    isPii: PII_CATEGORIES.includes(category),
    uploadedBy: req.user._id,
    note,
  });
  res.status(201).json({ document: doc });
});

// GET /api/documents/:id/download
const download = asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Document not found');
  }

  // Authorize: HR/Admin always, or the owner employee
  let allowed = isAdmin(req.user);
  if (!allowed) {
    const profile = await EmployeeProfile.findOne({ user: req.user._id });
    if (profile && profile._id.equals(doc.employee)) allowed = true;
  }
  if (!allowed) {
    res.status(403);
    throw new Error('Not authorized to access this document');
  }

  const safeName = path.basename(doc.fileName).replace(/"/g, '');
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Length', doc.sizeBytes);

  if (!storage.streamTo(doc.storagePath, res)) return res.status(404).json({ message: 'File not found' });
});

// DELETE /api/documents/:id
const remove = asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Document not found');
  }

  // HR can delete any; employee can delete only their own non-HR-issued doc
  if (!isAdmin(req.user)) {
    const profile = await EmployeeProfile.findOne({ user: req.user._id });
    const isOwner = profile && profile._id.equals(doc.employee);
    if (!isOwner || HR_ONLY_CATEGORIES.includes(doc.category)) {
      res.status(403);
      throw new Error('Not authorized to delete this document');
    }
  }

  try {
    storage.remove(doc.storagePath);
  } catch (err) {
    // Log but don't fail the request — DB cleanup still proceeds
    console.error('Storage remove failed:', err.message);
  }
  await doc.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// PATCH /api/documents/:id/status  { status, note }  (HR/Admin)
// Verify or reject an employee-submitted document.
const setStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  if (!['Submitted', 'Verified', 'Rejected'].includes(status)) {
    res.status(400);
    throw new Error('status must be Submitted, Verified or Rejected');
  }
  const doc = await Document.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Document not found');
  }
  doc.status = status;
  doc.reviewNote = note || undefined;
  doc.verifiedBy = status === 'Submitted' ? undefined : req.user._id;
  doc.verifiedAt = status === 'Submitted' ? undefined : new Date();
  await doc.save();
  res.json({ document: doc.toJSON() });
});

// GET /api/documents/categories  (helper for forms)
const categories = asyncHandler(async (req, res) => {
  res.json({
    selfUpload: SELF_UPLOAD_CATEGORIES,
    hrOnly: HR_ONLY_CATEGORIES,
    all: ALL_CATEGORIES,
    required: REQUIRED_DOCUMENT_CATEGORIES,
  });
});

module.exports = {
  listMine,
  uploadMine,
  listForEmployee,
  uploadForEmployee,
  download,
  remove,
  categories,
  setStatus,
};
