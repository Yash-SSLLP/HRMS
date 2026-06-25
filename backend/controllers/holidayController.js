const asyncHandler = require('express-async-handler');
const Holiday = require('../models/Holiday');
const { HOLIDAY_TYPES } = require('../models/Holiday');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// GET /api/holidays?year=YYYY   (any authenticated user)
const listHolidays = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.year) {
    const year = Number(req.query.year);
    filter.date = {
      $gte: new Date(year, 0, 1),
      $lt: new Date(year + 1, 0, 1),
    };
  }
  const holidays = await Holiday.find(filter).sort({ date: 1 });
  res.json({ count: holidays.length, holidays });
});

// POST /api/holidays   (HR/SuperAdmin)
const createHoliday = asyncHandler(async (req, res) => {
  const { name, date, type, description } = req.body;
  if (!name || !date) {
    res.status(400);
    throw new Error('name and date are required');
  }
  if (type && !HOLIDAY_TYPES.includes(type)) {
    res.status(400);
    throw new Error(`type must be one of ${HOLIDAY_TYPES.join(', ')}`);
  }
  const holiday = await Holiday.create({
    name,
    date,
    type: type || 'Public',
    description,
    createdBy: req.user._id,
  });

  // Announce the newly added holiday to all active users (in-app + push).
  const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
  await notifyMany(recipients.map((u) => u._id), {
    type: 'holiday',
    title: `New holiday: ${holiday.name}`,
    body: `${fmtDate(holiday.date)} — ${holiday.type} holiday`,
    link: 'calendar',
  });

  res.status(201).json({ holiday });
});

// PUT /api/holidays/:id   (HR/SuperAdmin)
const updateHoliday = asyncHandler(async (req, res) => {
  const holiday = await Holiday.findById(req.params.id);
  if (!holiday) {
    res.status(404);
    throw new Error('Holiday not found');
  }
  const { name, date, type, description } = req.body;
  if (type !== undefined && !HOLIDAY_TYPES.includes(type)) {
    res.status(400);
    throw new Error(`type must be one of ${HOLIDAY_TYPES.join(', ')}`);
  }
  if (name !== undefined) holiday.name = name;
  if (date !== undefined) holiday.date = date;
  if (type !== undefined) holiday.type = type;
  if (description !== undefined) holiday.description = description;
  await holiday.save();
  res.json({ holiday });
});

// DELETE /api/holidays/:id   (HR/SuperAdmin)
const deleteHoliday = asyncHandler(async (req, res) => {
  const holiday = await Holiday.findById(req.params.id);
  if (!holiday) {
    res.status(404);
    throw new Error('Holiday not found');
  }
  await holiday.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listHolidays, createHoliday, updateHoliday, deleteHoliday };
