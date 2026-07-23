/**
 * Travel controller — employee travel requests with an optional reimbursement
 * claim and receipt attachment. Employees raise/list requests and upload receipts;
 * HR/Admin review the travel decision and separately process the reimbursement.
 */
const asyncHandler = require('express-async-handler');
const path = require('path');
const TravelRequest = require('../models/TravelRequest');
const { TRAVEL_STATUS } = require('../models/TravelRequest');
const storage = require('../services/storage');

const EMPLOYEE_FIELDS = 'firstName lastName email';
// Statuses an admin may set when reviewing the travel request itself
const REVIEWABLE_STATUSES = ['Approved', 'Rejected', 'Completed'];
// Statuses an admin may set when processing the reimbursement claim
const REIMBURSEMENT_DECISIONS = ['Approved', 'Rejected', 'Reimbursed'];

function isAdmin(user) {
  return user.role === 'SuperAdmin' || user.role === 'HRManager';
}

/**
 * List travel requests raised by the caller, newest first.
 * @route GET /api/travel/me
 * @returns {{count: number, items: Object[]}}
 */
// GET /api/travel/me  — requests raised by the caller
const listMine = asyncHandler(async (req, res) => {
  const items = await TravelRequest.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

/**
 * Raise a travel request (status Pending), optionally flagging a reimbursement claim.
 * @route POST /api/travel
 * @param {string} req.body.purpose - required
 * @param {string} req.body.origin - required
 * @param {string} req.body.destination - required
 * @param {string} req.body.fromDate - required
 * @param {string} req.body.toDate - required
 * @param {string} [req.body.modeOfTravel]
 * @param {number} [req.body.estimatedCost]
 * @param {boolean} [req.body.reimbursementRequested] - when true seeds reimbursement fields (status Pending)
 * @returns {{item: Object}} (201)
 */
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

/**
 * Admin list of all travel requests, optionally filtered by status.
 * @route GET /api/travel  (HR/Admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, items: Object[]}} with populated employee
 */
// GET /api/travel  — admin list of all requests (optional ?status)
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const items = await TravelRequest.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

/**
 * Admin approves/rejects/completes a travel request (records reviewer + time).
 * @route PATCH /api/travel/:id/status  (HR/Admin)
 * @param {string} req.params.id - request id
 * @param {string} req.body.status - one of REVIEWABLE_STATUSES
 * @param {string} [req.body.reviewNote]
 * @returns {{item: Object}}
 */
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

/**
 * Admin processes the reimbursement claim on a request (separate from travel status).
 * @route PATCH /api/travel/:id/reimbursement  (HR/Admin)
 * @param {string} req.params.id - request id
 * @param {string} req.body.status - one of REIMBURSEMENT_DECISIONS
 * @param {string} [req.body.note]
 * @returns {{item: Object}}; 400 if no reimbursement was claimed
 */
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

/**
 * Owner uploads a reimbursement receipt (multipart); replaces any prior file.
 * @route POST /api/travel/:id/receipt  (multipart field: receipt)
 * @param {string} req.params.id - request id
 * @param {File} req.file - the uploaded receipt (image/PDF), required
 * @returns {{item: Object}}
 * @sideeffect persists via storage service; removes the previously stored receipt
 */
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
  // Permission gate: only the request owner may attach a receipt
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

/**
 * Stream the stored reimbursement receipt inline (owner or admin only).
 * @route GET /api/travel/:id/receipt
 * @param {string} req.params.id - request id
 * @returns {binary} the receipt file with an inferred Content-Type; 404 if none
 */
// GET /api/travel/:id/receipt — stream the receipt (owner or admin).
const getReceipt = asyncHandler(async (req, res) => {
  const item = await TravelRequest.findById(req.params.id);
  if (!item || !item.reimbursementReceiptPath) {
    res.status(404);
    throw new Error('No receipt on file for this request');
  }
  // Permission gate: only admins or the owner may view the receipt
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
  if (!storage.streamTo(item.reimbursementReceiptPath, res)) return res.status(404).json({ message: 'File not found' });
});

module.exports = { listMine, createRequest, listAll, reviewRequest, reviewReimbursement, uploadReceipt, getReceipt };
