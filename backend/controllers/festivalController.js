/**
 * Festival controller — CRUD for the reminder-only festival calendar
 * (Holi, Diwali, Raksha Bandhan, Eid, Christmas, Republic Day …), plus a
 * one-click fill from the built-in Indian festival list.
 *
 * A festival is NOT a holiday: it never marks a non-working day and never
 * touches payroll, attendance or leave. It exists to put a chip on the shared
 * calendar and to send everyone a heads-up the day before and a greeting on the
 * day itself (services/celebrationWorker.js). See models/Festival.js for why it
 * is a separate collection.
 *
 * Unlike createHoliday, creating a festival does NOT broadcast immediately —
 * a festival added eleven months ahead is not news, and seeding a year would
 * otherwise fire thirty pushes at everyone. The day-before and day-of digests
 * are the notification.
 *
 * Mutations are HR/SuperAdmin-only (enforced at the route layer via
 * 'leave.manage', the same capability that guards the holiday calendar).
 */
const asyncHandler = require('express-async-handler');
const Festival = require('../models/Festival');
const { festivalsForYear, availableYears } = require('../data/indianFestivals');

// Store a plain 'YYYY-MM-DD' at UTC midnight, matching how the calendar import
// stores holidays (services/calendarExcel.js). Read back through the IST
// helpers it lands on the intended calendar day either way — see utils/istDate.
function toDate(value) {
  if (value instanceof Date) return value;
  const str = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(`${str}T00:00:00Z`);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Same day, same name = the same entry — mirrors the holiday import's dedupe so
// re-seeding a year never doubles the calendar.
const sameDayRange = (d) => {
  const start = new Date(d);
  start.setUTCHours(0, 0, 0, 0);
  return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
};
const rx = (s) => new RegExp(`^${String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/**
 * List festivals, optionally scoped to a calendar year, sorted by date.
 * @route GET /api/festivals?year=YYYY   (any authenticated user)
 * @param {string} [req.query.year]
 * @returns {{count: number, festivals: Object[], seedableYears: number[]}}
 */
const listFestivals = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.year) {
    const year = Number(req.query.year);
    filter.date = { $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year + 1, 0, 1)) };
  }
  const festivals = await Festival.find(filter).sort({ date: 1 });
  res.json({ count: festivals.length, festivals, seedableYears: availableYears() });
});

/**
 * Create a festival reminder. Does not notify — see the file header.
 * @route POST /api/festivals   (HR/SuperAdmin)
 * @param {string} req.body.name - required
 * @param {string} req.body.date - required, 'YYYY-MM-DD'
 * @param {string} [req.body.emoji]
 * @param {string} [req.body.description]
 * @param {string} [req.body.greeting] - custom notification body
 * @param {boolean} [req.body.notify=true]
 * @returns {{festival: Object}} (201)
 */
const createFestival = asyncHandler(async (req, res) => {
  const { name, date, emoji, description, greeting, notify } = req.body;
  if (!name || !date) {
    res.status(400);
    throw new Error('name and date are required');
  }
  const when = toDate(date);
  if (!when) {
    res.status(400);
    throw new Error('date is not a valid date');
  }
  const festival = await Festival.create({
    name,
    date: when,
    emoji,
    description,
    greeting,
    notify: notify === undefined ? true : !!notify,
    createdBy: req.user._id,
  });
  res.status(201).json({ festival });
});

/**
 * Update a festival reminder (partial).
 * @route PUT /api/festivals/:id   (HR/SuperAdmin)
 * @returns {{festival: Object}}
 */
const updateFestival = asyncHandler(async (req, res) => {
  const festival = await Festival.findById(req.params.id);
  if (!festival) {
    res.status(404);
    throw new Error('Festival not found');
  }
  const { name, date, emoji, description, greeting, notify } = req.body;
  if (date !== undefined) {
    const when = toDate(date);
    if (!when) {
      res.status(400);
      throw new Error('date is not a valid date');
    }
    festival.date = when;
  }
  if (name !== undefined) festival.name = name;
  if (emoji !== undefined) festival.emoji = emoji;
  if (description !== undefined) festival.description = description;
  if (greeting !== undefined) festival.greeting = greeting;
  if (notify !== undefined) festival.notify = !!notify;
  await festival.save();
  res.json({ festival });
});

/**
 * Delete a festival reminder.
 * @route DELETE /api/festivals/:id   (HR/SuperAdmin)
 * @returns {{id: string, deleted: boolean}}
 */
const deleteFestival = asyncHandler(async (req, res) => {
  const festival = await Festival.findById(req.params.id);
  if (!festival) {
    res.status(404);
    throw new Error('Festival not found');
  }
  await festival.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Fill a whole year from the built-in Indian festival list. Entries already on
 * the calendar (same name, same day) are skipped, so it is safe to re-run and
 * safe to run after HR has edited a few dates by hand.
 * @route POST /api/festivals/seed   (HR/SuperAdmin)
 * @param {number} [req.body.year] - defaults to the current year
 * @returns {{year: number, created: number, skipped: number, festivals: Object[]}}
 */
const seedFestivals = asyncHandler(async (req, res) => {
  const year = Number(req.body?.year) || new Date().getFullYear();
  const list = festivalsForYear(year);
  if (!list.length) {
    res.status(400);
    throw new Error(
      `No built-in festival list for ${year}. Available: ${availableYears().join(', ') || 'none'}. `
      + 'Add festivals for this year one at a time, or ask a developer to add the year to backend/data/indianFestivals.js.'
    );
  }

  let created = 0;
  let skipped = 0;
  for (const f of list) {
    const when = toDate(f.date);
    const exists = await Festival.findOne({ name: rx(f.name), date: sameDayRange(when) }).select('_id');
    if (exists) {
      skipped += 1;
      continue;
    }
    await Festival.create({
      name: f.name,
      date: when,
      emoji: f.emoji || '',
      greeting: f.greeting || '',
      createdBy: req.user._id,
    });
    created += 1;
  }

  const festivals = await Festival.find({
    date: { $gte: new Date(Date.UTC(year, 0, 1)), $lt: new Date(Date.UTC(year + 1, 0, 1)) },
  }).sort({ date: 1 });
  res.status(created ? 201 : 200).json({ year, created, skipped, festivals });
});

module.exports = { listFestivals, createFestival, updateFestival, deleteFestival, seedFestivals };
