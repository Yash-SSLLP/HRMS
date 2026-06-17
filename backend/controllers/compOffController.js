const asyncHandler = require('express-async-handler');
const CompOff = require('../models/CompOff');

const EMPLOYEE_FIELDS = 'firstName lastName email';
const EXPIRY_DAYS = 90;

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// GET /api/compoff/me — comp-offs raised by the caller
const listMine = asyncHandler(async (req, res) => {
  const items = await CompOff.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: items.length, items });
});

// POST /api/compoff  { workedDate, reason }
const createRequest = asyncHandler(async (req, res) => {
  const { workedDate, reason } = req.body;
  if (!workedDate || !reason) {
    res.status(400);
    throw new Error('workedDate and reason are required');
  }

  const item = await CompOff.create({
    employee: req.user._id,
    workedDate,
    reason,
    status: 'Pending',
  });

  res.status(201).json({ item });
});

// PATCH /api/compoff/me/:id/avail — caller avails their own approved comp-off
const availMine = asyncHandler(async (req, res) => {
  const item = await CompOff.findOne({ _id: req.params.id, employee: req.user._id });
  if (!item) {
    res.status(404);
    throw new Error('Comp-off not found');
  }
  if (item.status !== 'Approved') {
    res.status(400);
    throw new Error('Only an approved comp-off can be availed');
  }

  item.status = 'Availed';
  item.availedOn = new Date();
  await item.save();

  res.json({ item });
});

// GET /api/compoff  (admin)  optional ?status
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const items = await CompOff.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .sort({ createdAt: -1 });

  res.json({ count: items.length, items });
});

// PATCH /api/compoff/:id/status  (admin)  { status, reviewNote }
const reviewRequest = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body;
  if (!['Approved', 'Rejected'].includes(status)) {
    res.status(400);
    throw new Error('status must be Approved or Rejected');
  }

  const item = await CompOff.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Comp-off not found');
  }

  item.status = status;
  item.reviewedBy = req.user._id;
  item.reviewedAt = new Date();
  if (reviewNote !== undefined) item.reviewNote = reviewNote;
  if (status === 'Approved') {
    item.expiryDate = addDays(item.workedDate, EXPIRY_DAYS);
  }

  await item.save();
  res.json({ item });
});

module.exports = { listMine, createRequest, availMine, listAll, reviewRequest };
