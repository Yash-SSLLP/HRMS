/**
 * Holiday controller — CRUD for the company holiday calendar, plus the bulk
 * Excel import that fills a whole year in one upload (holidays, org-wide comp-off
 * days and celebrations/events — see services/calendarExcel.js).
 *
 * Creating a holiday broadcasts an in-app + push notification to all active
 * users; the bulk import sends a single summary instead. Mutations are
 * HR/SuperAdmin-only (enforced at the route layer).
 */
const asyncHandler = require('express-async-handler');
const Holiday = require('../models/Holiday');
const { HOLIDAY_TYPES } = require('../models/Holiday');
const Event = require('../models/Event');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');
const { hasPermission } = require('../middleware/authMiddleware');
const calendarExcel = require('../services/calendarExcel');

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

/**
 * Download the three-sheet calendar import template (Holidays / Comp Offs /
 * Celebrations).
 * @route GET /api/holidays/template.xlsx   (HR/SuperAdmin)
 * @returns {Buffer} .xlsx stream
 */
// GET /api/holidays/template.xlsx   (HR/SuperAdmin)
const downloadCalendarTemplate = asyncHandler(async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="calendar-import-template.xlsx"');
  await calendarExcel.writeTemplate(res);
});

// Same day, same name = the same entry. Mirrors the duplicate check the holiday
// seed script uses, so re-uploading a corrected sheet doesn't double the calendar.
const sameDayRange = (d) => {
  const start = new Date(d);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  return { $gte: start, $lt: end };
};
const rx = (s) => new RegExp(`^${String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/**
 * Bulk-create calendar entries from an uploaded workbook: holidays, org-wide
 * comp-off days and celebrations (events).
 *
 * Duplicates (same name on the same day) are skipped rather than errored, so a
 * corrected sheet can be re-uploaded safely. Unlike createHoliday — which
 * broadcasts per holiday — the import sends ONE summary notification, because a
 * 20-row upload must not fire 20 pushes at everyone.
 * @route POST /api/holidays/import   (HR/SuperAdmin, multipart `file`)
 * @param {Express.Multer.File} req.file - the .xlsx upload
 * @returns {{created:{holidays:number,compOffs:number,celebrations:number}, skipped:Object[], errors:Object[]}}
 * @sideeffect one summary in-app + push notification to all other active users
 */
// POST /api/holidays/import   (HR/SuperAdmin)
const importCalendar = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400);
    throw new Error('Upload an .xlsx file in the "file" field');
  }

  let parsed;
  try {
    parsed = await calendarExcel.parseWorkbook(req.file.buffer);
  } catch (err) {
    res.status(400);
    throw new Error(`Could not read the workbook: ${err.message}`);
  }

  const errors = [...parsed.errors];
  const skipped = [];
  const created = { holidays: 0, compOffs: 0, celebrations: 0 };
  const createdHolidays = [];

  // Holidays + comp-off days both land in the Holiday collection; only `type`
  // differs, and the comp-off sheet has already forced it.
  for (const [rows, sheetName, bucket] of [
    [parsed.holidays, 'Holidays', 'holidays'],
    [parsed.compOffs, 'Comp Offs', 'compOffs'],
  ]) {
    for (const row of rows) {
      const exists = await Holiday.findOne({ name: rx(row.name), date: sameDayRange(row.date) }).select('_id');
      if (exists) {
        skipped.push({ sheet: sheetName, row: row.excelRow, message: `"${row.name}" already on the calendar` });
        continue;
      }
      const doc = await Holiday.create({
        name: row.name,
        date: row.date,
        type: row.type || 'Public',
        description: row.description,
        createdBy: req.user._id,
      });
      createdHolidays.push(doc);
      created[bucket] += 1;
    }
  }

  // Celebrations write Event documents, which are gated by their own capability.
  // Someone with holiday rights but not event rights still gets their holiday
  // rows imported — those rows are reported as skipped instead of failing all.
  if (parsed.celebrations.length) {
    if (!hasPermission(req.user, 'events.manage')) {
      for (const row of parsed.celebrations) {
        skipped.push({ sheet: 'Celebrations', row: row.excelRow, message: 'You do not have permission to create events' });
      }
    } else {
      for (const row of parsed.celebrations) {
        const exists = await Event.findOne({ title: rx(row.title), date: sameDayRange(row.date) }).select('_id');
        if (exists) {
          skipped.push({ sheet: 'Celebrations', row: row.excelRow, message: `"${row.title}" already on the calendar` });
          continue;
        }
        await Event.create({
          title: row.title,
          date: row.date,
          time: row.time,
          location: row.location,
          description: row.description,
          createdBy: req.user._id,
        });
        created.celebrations += 1;
      }
    }
  }

  // One summary broadcast for the whole import.
  const total = created.holidays + created.compOffs + created.celebrations;
  if (total) {
    const parts = [
      created.holidays && `${created.holidays} holiday${created.holidays === 1 ? '' : 's'}`,
      created.compOffs && `${created.compOffs} comp-off day${created.compOffs === 1 ? '' : 's'}`,
      created.celebrations && `${created.celebrations} celebration${created.celebrations === 1 ? '' : 's'}`,
    ].filter(Boolean);
    const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
    await notifyMany(recipients.map((u) => u._id), {
      type: 'holiday',
      title: 'Calendar updated',
      body: `${parts.join(', ')} added — see the calendar`,
      link: 'calendar',
    });
  }

  res.status(created.holidays + created.compOffs + created.celebrations ? 201 : 200).json({
    created,
    holidays: createdHolidays,
    skipped,
    errors,
  });
});

module.exports = {
  listHolidays, createHoliday, updateHoliday, deleteHoliday,
  downloadCalendarTemplate, importCalendar,
};
