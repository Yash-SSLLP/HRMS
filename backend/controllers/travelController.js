const asyncHandler = require('express-async-handler');
const TravelRequest = require('../models/TravelRequest');
const { TRAVEL_STATUS } = require('../models/TravelRequest');

const EMPLOYEE_FIELDS = 'firstName lastName email';
const REVIEWABLE_STATUSES = ['Approved', 'Rejected', 'Completed'];

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
  } = req.body;

  if (!purpose || !origin || !destination || !fromDate || !toDate) {
    res.status(400);
    throw new Error('purpose, origin, destination, fromDate and toDate are required');
  }

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

module.exports = { listMine, createRequest, listAll, reviewRequest };
