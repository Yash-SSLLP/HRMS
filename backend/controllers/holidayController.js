/**
 * Holiday controller — CRUD for the company holiday calendar. Creating a holiday
 * broadcasts an in-app + push notification to all active users. Mutations are
 * HR/SuperAdmin-only (enforced at the route layer).
 */
const asyncHandler = require('express-async-handler');
const Holiday = require('../models/Holiday');
const { HOLIDAY_TYPES } = require('../models/Holiday');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');

// Format a date as e.g. "5 Jan 2026" for notification bodies
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * List holidays, optionally scoped to a calendar year, sorted by date.
 * @route GET /api/holidays?year=YYYY   (any authenticated user)
 * @param {string} [req.query.year] - restrict to holidays within that year
 * @returns {{count: number, holidays: Object[]}}
 */
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

/**
 * Create a holiday and notify all active users of it.
 * @route POST /api/holidays   (HR/SuperAdmin)
 * @param {string} req.body.name - required
 * @param {string} req.body.date - required
 * @param {string} [req.body.type='Public'] - must be one of HOLIDAY_TYPES
 * @param {string} [req.body.description]
 * @returns {{holiday: Object}} the created holiday (201)
 * @sideeffect notifies every active user except the creator (in-app + push)
 */
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
    body: `${fmtDate(holiday.date)} - ${holiday.type} holiday`,
    link: 'calendar',
  });

  res.status(201).json({ holiday });
});

/**
 * Update a holiday's fields (partial).
 * @route PUT /api/holidays/:id   (HR/SuperAdmin)
 * @param {string} req.params.id - holiday id
 * @param {string} [req.body.name]
 * @param {string} [req.body.date]
 * @param {string} [req.body.type] - must be one of HOLIDAY_TYPES
 * @param {string} [req.body.description]
 * @returns {{holiday: Object}} the updated holiday
 */
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

/**
 * Delete a holiday by id.
 * @route DELETE /api/holidays/:id   (HR/SuperAdmin)
 * @param {string} req.params.id - holiday id
 * @returns {{id: string, deleted: boolean}}
 */
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
