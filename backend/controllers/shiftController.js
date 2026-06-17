const asyncHandler = require('express-async-handler');
const Shift = require('../models/Shift');
const RosterEntry = require('../models/RosterEntry');

const USER_FIELDS = 'firstName lastName';

// ===== Shifts (HR/Admin) =====
const listShifts = asyncHandler(async (req, res) => {
  const shifts = await Shift.find().sort({ createdAt: -1 });
  res.json({ count: shifts.length, shifts });
});

const createShift = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }
  const shift = await Shift.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ shift });
});

const updateShift = asyncHandler(async (req, res) => {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    res.status(404);
    throw new Error('Shift not found');
  }
  delete req.body.createdBy;
  Object.assign(shift, req.body);
  await shift.save();
  res.json({ shift });
});

const deleteShift = asyncHandler(async (req, res) => {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    res.status(404);
    throw new Error('Shift not found');
  }
  await shift.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Roster (HR/Admin) =====
const listRoster = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = new Date(req.query.from);
    if (req.query.to) filter.date.$lte = new Date(req.query.to);
  }
  const entries = await RosterEntry.find(filter)
    .populate('employee', USER_FIELDS)
    .populate('shift')
    .sort({ date: 1 });
  res.json({ count: entries.length, entries });
});

const assignRoster = asyncHandler(async (req, res) => {
  const { employee, date, shift, note } = req.body;
  if (!employee || !date || !shift) {
    res.status(400);
    throw new Error('employee, date and shift are required');
  }
  let entry = await RosterEntry.findOne({ employee, date: new Date(date) });
  if (entry) {
    entry.shift = shift;
    if (note !== undefined) entry.note = note;
    await entry.save();
  } else {
    entry = await RosterEntry.create({
      employee,
      date: new Date(date),
      shift,
      note,
      createdBy: req.user._id,
    });
  }
  res.status(201).json({ entry });
});

const deleteRoster = asyncHandler(async (req, res) => {
  const entry = await RosterEntry.findById(req.params.id);
  if (!entry) {
    res.status(404);
    throw new Error('Roster entry not found');
  }
  await entry.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Roster (Employee self-service) =====
const myRoster = asyncHandler(async (req, res) => {
  const filter = { employee: req.user._id };
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = new Date(req.query.from);
    if (req.query.to) filter.date.$lte = new Date(req.query.to);
  }
  const entries = await RosterEntry.find(filter).populate('shift').sort({ date: 1 });
  res.json({ count: entries.length, entries });
});

module.exports = {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
  listRoster,
  assignRoster,
  deleteRoster,
  myRoster,
};
