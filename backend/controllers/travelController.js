const asyncHandler = require('express-async-handler');
const path = require('path');
const TravelRequest = require('../models/TravelRequest');
const { TRAVEL_STATUS } = require('../models/TravelRequest');
const storage = require('../services/storage');

const EMPLOYEE_FIELDS = 'firstName lastName email';
const REVIEWABLE_STATUSES = ['Approved', 'Rejected', 'Completed'];
const REIMBURSEMENT_DECISIONS = ['Approved', 'Rejected', 'Reimbursed'];

function isAdmin(user) {
  return user.role === 'SuperAdmin' || user.role === 'HRManager';
}

// GET /api/travel/me  — requests raised by the caller
const listMine = asyncHandler(async (req, res) => {
  const items = await TravelRequest.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

// POST /api/travel  — raise a travel request
const createRequest = asyncHandler(async (req, res) => {
  const {
    purpose,
    origin,
    destination,
    fromDate,
    toDate,
    modeOfTravel,
    estimatedCost,
    advanceRequested,
    notes,
    reimbursementRequested,
    reimbursementAmount,
    reimbursementNote,
    reimbursementPaidOn,
  } = req.body;

  if (!purpose || !origin || !destination || !fromDate || !toDate) {
    res.status(400);
    throw new Error('purpose, origin, destination, fromDate and toDate are required');
  }

  const wantsReimbursement = !!reimbursementRequested;

  const item = await TravelRequest.create({
    employee: req.user._id,
    purpose,
    origin,
    destination,
    fromDate,
    toDate,
    modeOfTravel,
    estimatedCost,
    advanceRequested,
    notes,
    status: 'Pending',
    reimbursementRequested: wantsReimbursement,
    reimbursementAmount: wantsReimbursement ? Number(reimbursementAmount) || 0 : 0,
    reimbursementNote: wantsReimbursement ? reimbursementNote : undefined,
    reimbursementPaidOn: wantsReimbursement && reimbursementPaidOn ? reimbursementPaidOn : undefined,
    reimbursementStatus: wantsReimbursement ? 'Pending' : 'None',
  });

  res.status(201).json({ item });
});

// GET /api/travel  — admin list of all requests (optional ?status)
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const items = await TravelRequest.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

// PATCH /api/travel/:id/status  { status, reviewNote }  — admin review
const reviewRequest = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;

  if (!REVIEWABLE_STATUSES.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${REVIEWABLE_STATUSES.join(', ')}`);
  }

  const item = await TravelRequest.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Travel request not found');
  }

  item.status = status;
  if (reviewNote !== undefined) item.reviewNote = reviewNote;
  item.reviewedBy = req.user._id;
  item.reviewedAt = new Date();

  await item.save();
  res.json({ item });
});

// PATCH /api/travel/:id/reimbursement  { status, note }  — admin processes a claim
const reviewReimbursement = asyncHandler(async (req, res) => {
  const { status, note } = req.body;

  if (!REIMBURSEMENT_DECISIONS.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${REIMBURSEMENT_DECISIONS.join(', ')}`);
  }

  const item = await TravelRequest.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Travel request not found');
  }
  if (!item.reimbursementRequested) {
    res.status(400);
    throw new Error('No reimbursement was claimed on this request');
  }

  item.reimbursementStatus = status;
  if (note !== undefined) item.reimbursementDecisionNote = note;
  item.reimbursementReviewedBy = req.user._id;
  item.reimbursementReviewedAt = new Date();

  await item.save();
  res.json({ item });
});

// POST /api/travel/:id/receipt  (multipart: receipt) — owner uploads proof of
// the payment they already made.
const uploadReceipt = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('A receipt file is required');
  }
  const item = await TravelRequest.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Travel request not found');
  }
  if (!item.employee.equals(req.user._id)) {
    res.status(403);
    throw new Error('You can only attach a receipt to your own request');
  }
  const { storagePath } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'travel-receipts',
    ownerId: item._id,
    originalName: req.file.originalname || 'receipt',
  });
  if (item.reimbursementReceiptPath && item.reimbursementReceiptPath !== storagePath) {
    try { storage.remove(item.reimbursementReceiptPath); } catch { /* best effort */ }
  }
  item.reimbursementReceiptPath = storagePath;
  item.reimbursementReceiptName = req.file.originalname || 'receipt';
  await item.save();
  res.json({ item });
});

// GET /api/travel/:id/receipt — stream the receipt (owner or admin).
const getReceipt = asyncHandler(async (req, res) => {
  const item = await TravelRequest.findById(req.params.id);
  if (!item || !item.reimbursementReceiptPath) {
    res.status(404);
    throw new Error('No receipt on file for this request');
  }
  if (!isAdmin(req.user) && !item.employee.equals(req.user._id)) {
    res.status(403);
    throw new Error('Not authorized to view this receipt');
  }
  const ext = path.extname(item.reimbursementReceiptPath).toLowerCase();
  const type = ext === '.pdf' ? 'application/pdf'
    : ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `inline; filename="${item.reimbursementReceiptName || 'receipt'}"`);
  storage.readStream(item.reimbursementReceiptPath).pipe(res);
});

module.exports = { listMine, createRequest, listAll, reviewRequest, reviewReimbursement, uploadReceipt, getReceipt };
