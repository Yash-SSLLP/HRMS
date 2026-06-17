const asyncHandler = require('express-async-handler');
const Regularization = require('../models/Regularization');
const { REGULARIZATION_STATUS } = require('../models/Regularization');

const EMPLOYEE_FIELDS = 'firstName lastName email';

// GET /api/regularizations/me  — the caller's own requests
const listMine = asyncHandler(async (req, res) => {
  const items = await Regularization.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

// POST /api/regularizations  { date, type, requestedCheckIn, requestedCheckOut, reason }
const createRequest = asyncHandler(async (req, res) => {
  const { date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;

  if (!date || !reason) {
    res.status(400);
    throw new Error('date and reason are required');
  }

  const item = await Regularization.create({
    employee: req.user._id,
    date,
    type,
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Pending',
  });

  res.status(201).json({ item });
});

// GET /api/regularizations  (admin) — optional ?status filter
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const items = await Regularization.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

// PATCH /api/regularizations/:id/status  (admin)  { status, reviewNote }
const reviewRequest = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;

  if (!['Approved', 'Rejected'].includes(status)) {
    res.status(400);
    throw new Error('status must be Approved or Rejected');
  }

  const item = await Regularization.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Regularization request not found');
  }

  item.status = status;
  item.reviewNote = reviewNote;
  item.reviewedBy = req.user._id;
  item.reviewedAt = new Date();
  await item.save();

  res.json({ item });
});

module.exports = { listMine, createRequest, listAll, reviewRequest };
