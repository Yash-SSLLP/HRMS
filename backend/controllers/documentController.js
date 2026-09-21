/**
 * Document controller — employee document store (Document). Employees upload/list
 * a limited set of self-upload categories; HR upload any category on an employee's
 * behalf and verify/reject submissions. Files persist to local disk (primary) with
 * a best-effort Cloudinary backup, and downloads fall back to the cloud copy.
 * Category constants gate who may upload/delete what.
 */
const asyncHandler = require('express-async-handler');
const path = require('path');
const Document = require('../models/Document');
const {
  SELF_UPLOAD_CATEGORIES,
  ALL_CATEGORIES,
  HR_ONLY_CATEGORIES,
  PII_CATEGORIES,
  REQUIRED_DOCUMENT_CATEGORIES,
  CATEGORY_LABELS,
  RETIRED_CATEGORIES,
  MULTI_UPLOAD_CATEGORIES,
  WAIVABLE_REQUIREMENTS,
  missingRequiredDocuments,
} = require('../models/Document');
const EmployeeProfile = require('../models/EmployeeProfile');
const DocumentChangeRequest = require('../models/DocumentChangeRequest');
const Notification = require('../models/Notification');
const User = require('../models/User');
const storage = require('../services/storage');
const cloudinary = require('../services/cloudinary');
const { scopeEmployeeFilter, cannotManageProfile } = require('../utils/employeeScope');
const { hasPermission, isPortalViewer } = require('../middleware/authMiddleware');

/**
 * Company/ownership wall for a single document: may this ADMIN not touch it?
 * (The owner-employee path is decided separately by each endpoint.) Loads the
 * owning profile and applies the shared scope rule, so an HR Manager of
 * company A cannot read company B's identity documents by id.
 * @param {import('express').Request} req
 * @param {Object} doc - a Document (needs `employee`)
 * @returns {Promise<boolean>} true when out of scope
 */
async function adminCannotTouchDoc(req, doc) {
  if (req.user.role === 'SuperAdmin') return false; // skip the lookup
  const profile = await EmployeeProfile.findById(doc.employee).select('hrPartner company').lean();
  return cannotManageProfile(req, profile);
}

// Best-effort durable backup of an uploaded document to Cloudinary. Never throws
// — a failed backup must not block the upload; the local disk copy is primary.
async function backupToCloud(buffer, ownerId, doc) {
  if (!cloudinary.enabled()) return;
  try {
    const cloud = await cloudinary.uploadFileBuffer(buffer, {
      folder: `${process.env.CLOUDINARY_FOLDER || 'hrms-lms'}/documents/${ownerId}`,
    });
    doc.cloud = cloud;
    await doc.save();
  } catch (err) {
    console.error('[documents] Cloudinary backup failed:', err.message);
  }
}

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

/**
 * The declarations on a profile, as a plain object that is always safe to read.
 *
 * Every profile saved before this existed has no `docDeclarations` at all, and
 * the requirement rule indexes into it by name — so an absent sub-document must
 * come back as "declared nothing", not as undefined.
 * @param {Object|null} profile - an EmployeeProfile (doc or lean)
 * @returns {{firstJob: boolean, firstJobAt: Date|undefined,
 *   noOtherDocuments: boolean, noOtherDocumentsAt: Date|undefined}}
 */
function declarationsOf(profile) {
  const d = profile?.docDeclarations || {};
  return {
    firstJob: !!d.firstJob,
    firstJobAt: d.firstJobAt,
    noOtherDocuments: !!d.noOtherDocuments,
    noOtherDocumentsAt: d.noOtherDocumentsAt,
  };
}

// The base role pair. Kept as the building block for the two gates below.
function isAdmin(user) {
  return user.role === 'SuperAdmin' || user.role === 'HRManager';
}

// Write-side gate: who may upload for / delete somebody ELSE's document. Follows
// the capability rather than the role pair, so it lines up with the sibling
// routes that ARE gated (POST / and PATCH /:id/status both require
// 'documents.manage'): a CEO/MD switched into edit mode writes here like an HR
// Manager, and a Manager granted the capability can delete what they may upload.
// A read-only exec is excluded — hasPermission returns false for them, which is
// exactly the intent. adminCannotTouchDoc still applies the wall per document.
function canManageOthersDocs(user) {
  return isAdmin(user) || hasPermission(user, 'documents.manage');
}

// Read-side gate: who may DOWNLOAD somebody else's document. The same audience
// the documents admin list is gated on (routes: requirePermission
// 'documents.manage'), which is wider than isAdmin above — a read-only CEO/MD
// holds no capability in the catalog (their access is requirePermission's
// safe-method exemption), and a Manager may be granted 'documents.manage'.
// Both can already see the rows, so both must be able to open the files.
// adminCannotTouchDoc still applies the company / hrPartner wall per document.
function canReadOthersDocs(user) {
  return isAdmin(user) || isPortalViewer(user) || hasPermission(user, 'documents.manage');
}

// ===== Employee =====

/**
 * List the caller's own documents, newest first, with what is still
 * outstanding and the declarations that can answer part of it.
 *
 * `missing` is computed HERE rather than by each client filtering the required
 * list: a waived requirement and an equivalent category (a relieving letter
 * standing in for an experience letter) are one rule, and it lives in the model.
 * @route GET /api/documents/me
 * @returns {{count: number, documents: Object[], missing: string[],
 *   declarations: Object}}
 */
// GET /api/documents/me
const listMine = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const docs = await Document.find({ employee: profile._id }).sort({ createdAt: -1 });
  const declarations = declarationsOf(profile);
  res.json({
    count: docs.length,
    documents: docs,
    declarations,
    missing: missingRequiredDocuments(docs.map((d) => d.category), declarations),
  });
});

/**
 * Set the caller's own document declarations.
 *
 * Each field is optional and only what is SENT is changed, so the two switches
 * can be flipped independently without the client having to echo the other one
 * back and race itself. The timestamp is stamped on the way to true and cleared
 * on the way to false, so it always describes the declaration that stands.
 * @route PATCH /api/documents/me/declarations  { firstJob?, noOtherDocuments? }
 * @returns {{declarations: Object, missing: string[]}}
 */
const setMyDeclarations = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const fields = Object.values(WAIVABLE_REQUIREMENTS);
  const given = fields.filter((f) => req.body[f] !== undefined);
  if (!given.length) {
    res.status(400);
    throw new Error(`Nothing to set. Send one of: ${fields.join(', ')}`);
  }
  profile.docDeclarations = profile.docDeclarations || {};
  for (const f of given) {
    const on = req.body[f] === true || req.body[f] === 'true';
    profile.docDeclarations[f] = on;
    profile.docDeclarations[`${f}At`] = on ? new Date() : undefined;
  }
  await profile.save();

  const cats = await Document.find({ employee: profile._id }).select('category').lean();
  const declarations = declarationsOf(profile);
  res.json({ declarations, missing: missingRequiredDocuments(cats.map((d) => d.category), declarations) });
});

/**
 * Employee uploads a document in an allowed self-upload category.
 *
 * Also the REPLACE path: `replaces` names a document this file supersedes, and
 * without it an upload supersedes the single file its category already holds
 * (a multi category simply gains one). Either way it is refused (409) when the
 * file being replaced is Verified — that goes through requestReplacement.
 * @route POST /api/documents/me  (multipart: file + category [+ replaces])
 * @param {File} req.file - the file (required)
 * @param {string} req.body.category - must be in SELF_UPLOAD_CATEGORIES
 * @param {string} [req.body.note]
 * @returns {{document: Object}} (201)
 * @sideeffect persists to disk and best-effort backs up to Cloudinary
 */
// POST /api/documents/me  (multipart: file + category)
const uploadMine = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('File is required (multipart field "file")');
  }
  const { category, note, replaces } = req.body;
  if (!SELF_UPLOAD_CATEGORIES.includes(category)) {
    res.status(400);
    throw new Error(`Employees may upload only: ${SELF_UPLOAD_CATEGORIES.join(', ')}`);
  }
  const profile = await getMyProfileOrFail(req.user._id, res);

  const existing = await Document.find({ employee: profile._id, category });

  // WHAT THIS UPLOAD REPLACES, if anything:
  //   `replaces`  a named document — the Replace button on one row, which must
  //               touch that file and no other.
  //   otherwise   the single file the category holds, for the categories that
  //               hold one. A multi category (a letter per past employer, a
  //               certificate per qualification, anything under Other) just
  //               gains a file — clearing it out to make room for one would
  //               throw away everything already sent through the public link.
  let superseding = [];
  if (replaces) {
    const target = existing.find((d) => String(d._id) === String(replaces));
    if (!target) {
      res.status(404);
      throw new Error('That document is no longer on file — upload it as a new one.');
    }
    superseding = [target];
  } else if (!MULTI_UPLOAD_CATEGORIES.includes(category)) {
    superseding = existing;
  }

  // VERIFIED is the lock, and the only one. HR has checked that copy and signed
  // it off, so undoing it is their call: that still goes through a replacement
  // request. Everything short of it the employee replaces themselves — a file
  // still awaiting verification, or one HR sent back — because nothing has been
  // accepted yet, so nothing is being undone. Before this, a typo or the wrong
  // side of a card sat there until HR got round to a request, which is a lot of
  // ceremony for a scan nobody has looked at.
  if (superseding.some((d) => d.status === 'Verified')) {
    res.status(409);
    throw new Error('This document has already been verified by HR. To change it, ask your HR to replace it.');
  }
  for (const stale of superseding) {
    // Anything raised against the copy being replaced now has nothing to point
    // at. Close it here, or it sits in HR's queue proposing a swap for a
    // document that no longer exists.
    await closePendingReplacements(stale._id, req.user._id);
    try { await storage.remove(stale.storagePath); } catch (_) { /* best-effort */ }
    await stale.deleteOne();
  }

  const { storagePath, sha256, sizeBytes } = await storage.saveBuffer({
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
  await backupToCloud(req.file.buffer, profile._id, doc);
  res.status(201).json({ document: doc });
});

// ===== HR/Admin =====

/**
 * List documents, optionally filtered by employee.
 * @route GET /api/documents?employee=  (HR/Admin)
 * @param {string} [req.query.employee] - EmployeeProfile id
 * @returns {{count: number, documents: Object[]}} with populated employee
 */
// GET /api/documents?employee=
const listForEmployee = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  // Scoped like the employee directory: an admin sees only their own
  // employees' documents (and a requested ?employee= outside that matches nothing).
  await scopeEmployeeFilter(req, filter);
  const docs = await Document.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ createdAt: -1 });
  res.json({ count: docs.length, documents: docs });
});

/**
 * HR uploads a document on an employee's behalf (any category).
 * @route POST /api/documents  (HR/Admin, multipart: file + employee + category)
 * @param {File} req.file - the file (required)
 * @param {string} req.body.employee - EmployeeProfile id (required)
 * @param {string} req.body.category - must be in ALL_CATEGORIES (required)
 * @param {string} [req.body.note]
 * @returns {{document: Object}} (201)
 * @sideeffect persists to disk and best-effort backs up to Cloudinary
 */
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
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage documents of employees assigned to you');
  }

  const { storagePath, sha256, sizeBytes } = await storage.saveBuffer({
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
  await backupToCloud(req.file.buffer, profile._id, doc);
  res.status(201).json({ document: doc });
});

/**
 * Download a document (HR/Admin, or the owning employee); disk first, cloud fallback.
 * @route GET /api/documents/:id/download
 * @param {string} req.params.id - document id
 * @returns {binary} the file as an attachment; 403 if unauthorized, 404 if missing
 */
// GET /api/documents/:id/download
const download = asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Document not found');
  }

  // Permission gate: HR/Admin (within their company/assignment scope), or the
  // owner employee.
  let allowed = canReadOthersDocs(req.user) && !(await adminCannotTouchDoc(req, doc));
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

  // Primary: local disk. If the file is missing (e.g. ephemeral disk wiped on a
  // redeploy), fall back to the durable Cloudinary backup.
  if (await storage.exists(doc.storagePath)) {
    res.setHeader('Content-Length', doc.sizeBytes);
    if (await storage.streamTo(doc.storagePath, res)) return;
  }
  if (doc.cloud && doc.cloud.publicId && cloudinary.enabled()) {
    try {
      const upstream = await fetch(cloudinary.fileDeliveryUrl(doc.cloud));
      if (upstream.ok) return res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error('[documents] Cloudinary backup fetch failed:', err.message);
    }
  }
  return res.status(404).json({ message: 'File not found' });
});

/**
 * Delete a document (HR any; employee only their own non-HR-issued doc).
 * @route DELETE /api/documents/:id
 * @param {string} req.params.id - document id
 * @returns {{id: string, deleted: boolean}}; 403 if unauthorized
 */
// DELETE /api/documents/:id
const remove = asyncHandler(async (req, res) => {
  const doc = await Document.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Document not found');
  }

  // Permission gate: HR can delete any within their scope; employee only their
  // own non-HR-issued doc.
  if (canManageOthersDocs(req.user) && (await adminCannotTouchDoc(req, doc))) {
    res.status(403);
    throw new Error('Not authorized to delete this document');
  }
  if (!canManageOthersDocs(req.user)) {
    const profile = await EmployeeProfile.findOne({ user: req.user._id });
    const isOwner = profile && profile._id.equals(doc.employee);
    if (!isOwner || HR_ONLY_CATEGORIES.includes(doc.category)) {
      res.status(403);
      throw new Error('Not authorized to delete this document');
    }
    // Deleting is NOT the same act as replacing, so it keeps the stricter rule:
    // an employee may replace an unverified document themselves, but removing it
    // outright leaves a required document missing, and only a Rejected one (sent
    // back by HR) is theirs to withdraw.
    if (doc.status !== 'Rejected') {
      res.status(403);
      const fix = doc.status === 'Verified'
        ? 'Ask your HR to replace it.'
        : 'Upload a new file in this category to replace it.';
      throw new Error(`This document is already submitted and can no longer be removed. ${fix}`);
    }
  }

  try {
    await storage.remove(doc.storagePath);
  } catch (err) {
    // Log but don't fail the request — DB cleanup still proceeds
    console.error('Storage remove failed:', err.message);
  }
  await doc.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Set a document's verification status (verify/reject a submission).
 * @route PATCH /api/documents/:id/status  (HR/Admin)
 * @param {string} req.params.id - document id
 * @param {string} req.body.status - 'Submitted' | 'Verified' | 'Rejected'
 * @param {string} [req.body.note]
 * @returns {{document: Object}}; records verifiedBy/verifiedAt unless status is Submitted
 */
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
  if (await adminCannotTouchDoc(req, doc)) {
    res.status(403);
    throw new Error('You can only verify documents of employees assigned to you');
  }
  doc.status = status;
  doc.reviewNote = note || undefined;
  doc.verifiedBy = status === 'Submitted' ? undefined : req.user._id;
  doc.verifiedAt = status === 'Submitted' ? undefined : new Date();
  await doc.save();
  res.json({ document: doc.toJSON() });
});

/**
 * Return the document category constants for building upload forms.
 * @route GET /api/documents/categories
 * @returns {{selfUpload, hrOnly, all, required}} category name arrays
 */
// GET /api/documents/categories  (helper for forms)
const categories = asyncHandler(async (req, res) => {
  res.json({
    selfUpload: SELF_UPLOAD_CATEGORIES,
    hrOnly: HR_ONLY_CATEGORIES,
    all: ALL_CATEGORIES,
    required: REQUIRED_DOCUMENT_CATEGORIES,
    // Only the keys whose on-screen name is not just the camelCase split, and
    // which requirement each declaration answers — so a client never has to
    // hard-code either and drift from the server.
    labels: CATEGORY_LABELS,
    waivable: WAIVABLE_REQUIREMENTS,
    // Still valid on documents already filed (they are in `all`, so a status
    // change on one saves), but nobody is offered them for a NEW upload. A
    // picker built from `all` must subtract these.
    retired: RETIRED_CATEGORIES,
    // Categories that hold several files, so a client knows an upload here adds
    // rather than replaces (and must not warn that it will overwrite).
    multi: MULTI_UPLOAD_CATEGORIES,
  });
});

// ===== Document replacement requests =====

/**
 * Close any pending replacement request aimed at a document that is about to be
 * superseded, discarding the file it was holding.
 *
 * Reachable only for requests raised before a document could be replaced
 * directly — today one is only ever raised against a verified document, and a
 * verified document is never superseded. It stays because leaving an orphaned
 * request in an HR queue is worse than a few lines that rarely run.
 * @param {import("mongoose").Types.ObjectId} docId - the document going away
 * @param {import("mongoose").Types.ObjectId} actorId - who superseded it
 * @returns {Promise<void>}
 */
async function closePendingReplacements(docId, actorId) {
  const open = await DocumentChangeRequest.find({ targetDoc: docId, status: 'pending' });
  for (const dcr of open) {
    try { await storage.remove(dcr.storagePath); } catch (_) { /* best-effort */ }
    dcr.status = 'declined';
    dcr.decisionNote = 'Withdrawn — a new file was uploaded directly.';
    dcr.decidedBy = actorId;
    dcr.decidedAt = new Date();
    await dcr.save();
  }
}

// The HR partner (or a SuperAdmin) who decides an employee's document requests.
async function resolveDocAssignee(profile) {
  if (profile?.hrPartner) return profile.hrPartner;
  const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 });
  return sa?._id;
}

/**
 * Employee requests to replace a VERIFIED (locked) document, attaching the new
 * file. Routed to their HR partner; on approval the old file is swapped out.
 * Anything not yet verified is replaced directly through uploadMine instead.
 * @route POST /api/documents/me/:id/replace-request  (multipart: file + reason)
 */
const requestReplacement = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('A replacement file is required (multipart field "file")');
  }
  const profile = await getMyProfileOrFail(req.user._id, res);
  const doc = await Document.findById(req.params.id);
  if (!doc || !profile._id.equals(doc.employee)) {
    res.status(404);
    throw new Error('Document not found');
  }
  if (HR_ONLY_CATEGORIES.includes(doc.category)) {
    res.status(403);
    throw new Error('This document is managed by HR — ask them to update it.');
  }
  // Only a verified document needs HR to agree to the swap. Anything else the
  // employee replaces themselves through POST /documents/me, so sending it here
  // would put a decision in front of HR that nobody needs to make.
  if (doc.status !== 'Verified') {
    res.status(400);
    throw new Error('This document has not been verified yet — upload the corrected file directly instead.');
  }
  const dup = await DocumentChangeRequest.findOne({ targetDoc: doc._id, status: 'pending' });
  if (dup) {
    res.status(409);
    throw new Error('A replacement request for this document is already pending.');
  }

  const { storagePath, sha256, sizeBytes } = await storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'employee',
    ownerId: profile._id,
    originalName: req.file.originalname,
  });

  const assignedTo = await resolveDocAssignee(profile);
  const dcr = await DocumentChangeRequest.create({
    employee: profile._id,
    requestedBy: req.user._id,
    assignedTo,
    category: doc.category,
    targetDoc: doc._id,
    fileName: req.file.originalname,
    storagePath,
    mime: req.file.mimetype,
    sizeBytes,
    sha256,
    reason: req.body.note ? String(req.body.note).trim() : undefined,
  });
  if (assignedTo) {
    await Notification.create({
      recipient: assignedTo,
      type: 'change_request',
      audience: 'admin',
      title: 'Document replacement request',
      body: `${req.user.firstName} ${req.user.lastName} wants to replace their ${doc.category}.`,
      link: 'documents',
    });
  }
  res.status(201).json({ request: dcr.toJSON() });
});

/**
 * The caller's own document-replacement requests.
 * @route GET /api/documents/me/replace-requests
 */
const myReplacementRequests = asyncHandler(async (req, res) => {
  const requests = await DocumentChangeRequest.find({ requestedBy: req.user._id })
    .populate('decidedBy', 'firstName lastName')
    .sort({ createdAt: -1 });
  res.json({ count: requests.length, requests: requests.map((r) => r.toJSON()) });
});

/**
 * HR inbox of document-replacement requests routed to the admin (SuperAdmin: all).
 * @route GET /api/documents/replace-requests/assigned  (HR/Admin)
 */
const assignedReplacementRequests = asyncHandler(async (req, res) => {
  if (!canReadOthersDocs(req.user)) {
    res.status(403);
    throw new Error('Only HR/Admin have a document-request inbox');
  }
  // An exec is never anybody's assigned HR partner, so "assigned to me" would
  // always come back empty for them — and the admin Documents page (web and the
  // mobile Approvals screen) calls this on load. Their oversight view is every
  // request inside their company wall instead. A SuperAdmin still opts into the
  // org-wide view with ?all=true; scopeEmployeeFilter is a no-op for them.
  const orgWide = isPortalViewer(req.user)
    || (req.user.role === 'SuperAdmin' && req.query.all === 'true');
  const filter = orgWide
    ? await scopeEmployeeFilter(req, {})
    : { assignedTo: req.user._id };
  const requests = await DocumentChangeRequest.find(filter)
    .populate({ path: 'employee', select: 'employeeCode user', populate: { path: 'user', select: 'firstName lastName' } })
    .populate('requestedBy', 'firstName lastName')
    .populate('decidedBy', 'firstName lastName')
    .sort({ createdAt: -1 });
  res.json({ count: requests.length, requests: requests.map((r) => r.toJSON()) });
});

/**
 * Approve (swap the file in) or decline a document-replacement request.
 * @route PATCH /api/documents/replace-requests/:id  { action, decisionNote }  (HR/Admin)
 */
const decideReplacement = asyncHandler(async (req, res) => {
  const dcr = await DocumentChangeRequest.findById(req.params.id);
  if (!dcr) {
    res.status(404);
    throw new Error('Request not found');
  }
  const isAssignee = dcr.assignedTo && dcr.assignedTo.equals(req.user._id);
  if (!isAssignee && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only the assigned HR or a SuperAdmin can decide this');
  }
  if (dcr.status !== 'pending') {
    res.status(400);
    throw new Error('This request has already been decided');
  }
  const { action, decisionNote } = req.body;
  if (!['approve', 'decline'].includes(action)) {
    res.status(400);
    throw new Error("action must be 'approve' or 'decline'");
  }

  if (action === 'approve') {
    // Swap the file: remove the old document, promote the stored new file.
    const old = dcr.targetDoc ? await Document.findById(dcr.targetDoc) : null;
    if (old) {
      try { await storage.remove(old.storagePath); } catch (_) { /* best-effort */ }
      await old.deleteOne();
    }
    await Document.create({
      employee: dcr.employee,
      category: dcr.category,
      fileName: dcr.fileName,
      storagePath: dcr.storagePath,
      mime: dcr.mime,
      sizeBytes: dcr.sizeBytes,
      sha256: dcr.sha256,
      isPii: PII_CATEGORIES.includes(dcr.category),
      uploadedBy: dcr.requestedBy,
      status: 'Submitted',
    });
    dcr.status = 'approved';
  } else {
    // Discard the proposed file.
    try { await storage.remove(dcr.storagePath); } catch (_) { /* best-effort */ }
    dcr.status = 'declined';
  }
  dcr.decisionNote = decisionNote ? String(decisionNote).trim() : undefined;
  dcr.decidedBy = req.user._id;
  dcr.decidedAt = new Date();
  await dcr.save();

  await Notification.create({
    recipient: dcr.requestedBy,
    type: 'change_request',
    title: `Document replacement ${dcr.status}`,
    body: `Your request to replace your ${dcr.category} was ${dcr.status}.`,
    link: 'documents',
  });
  res.json({ request: dcr.toJSON() });
});

module.exports = {
  listMine,
  uploadMine,
  setMyDeclarations,
  listForEmployee,
  uploadForEmployee,
  download,
  remove,
  categories,
  setStatus,
  requestReplacement,
  myReplacementRequests,
  assignedReplacementRequests,
  decideReplacement,
  // Exported for the approvals badge count (approvalController.countHrApprovals),
  // which must gate its DocumentChangeRequest tally on the same audience this
  // inbox is gated on.
  canReadOthersDocs,
};
