/**
 * Event controller — CRUD for company calendar Events. Creating an event fans out
 * an in-app + push notification to all active users. Mutations are HR/SuperAdmin.
 */
const asyncHandler = require('express-async-handler');
const Event = require('../models/Event');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');

// Format a date as e.g. "5 Jan 2026" for notification bodies
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * List events, optionally scoped to a calendar year, sorted by date.
 * @route GET /api/events?year=YYYY   (any authenticated user)
 * @param {string} [req.query.year]
 * @returns {{count: number, events: Object[]}} with populated createdBy
 */
const listEvents = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.year) {
    const year = Number(req.query.year);
    filter.date = { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) };
  }
  const events = await Event.find(filter)
    .populate('createdBy', 'firstName lastName role')
    .sort({ date: 1 });
  res.json({ count: events.length, events });
});

/**
 * Create a calendar event and notify all other active users.
 * @route POST /api/events   (HR/SuperAdmin)
 * @param {string} req.body.title - required
 * @param {string} req.body.date - required
 * @param {string} [req.body.time]
 * @param {string} [req.body.location]
 * @param {string} [req.body.description]
 * @returns {{event: Object, notified: number}} (201)
 * @sideeffect notifies every active user except the creator
 */
// POST /api/events   (HR/SuperAdmin) — fans out a notification to every other active user
const createEvent = asyncHandler(async (req, res) => {
  const { title, date, time, location, description } = req.body;
  if (!title || !date) {
    res.status(400);
    throw new Error('title and date are required');
  }

  const event = await Event.create({
    title,
    date,
    time,
    location,
    description,
    createdBy: req.user._id,
  });

  // Notify (in-app + push) all active users except the creator.
  const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
  const detail = [event.time, event.location].filter(Boolean).join(' · ');
  await notifyMany(recipients.map((u) => u._id), {
    type: 'event',
    title: `New event: ${event.title}`,
    body: `${fmtDate(event.date)}${detail ? ` - ${detail}` : ''}`,
    link: 'calendar',
  });

  res.status(201).json({ event, notified: recipients.length });
});

/**
 * Update a calendar event's fields (partial).
 * @route PUT /api/events/:id   (HR/SuperAdmin)
 * @param {string} req.params.id - event id
 * @param {Object} req.body - title/date/time/location/description
 * @returns {{event: Object}}
 */
// PUT /api/events/:id   (HR/SuperAdmin)
const updateEvent = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    res.status(404);
    throw new Error('Event not found');
  }
  // Snapshot the details people plan around, so the save below can be compared
  // against them.
  const before = {
    title: event.title,
    date: new Date(event.date).getTime(),
    time: event.time || '',
    location: event.location || '',
  };

  const { title, date, time, location, description } = req.body;
  if (title !== undefined) event.title = title;
  if (date !== undefined) event.date = date;
  if (time !== undefined) event.time = time;
  if (location !== undefined) event.location = location;
  if (description !== undefined) event.description = description;
  await event.save();

  // A rescheduled or moved event is exactly the thing attendees must be told
  // about, and until now only creation notified — someone who saw "Friday, 4pm"
  // kept that in their head after HR changed it. Only the details people plan
  // around count as a change: a description tidy-up must not push everyone.
  const changed = [];
  if (before.title !== event.title) changed.push('renamed');
  if (before.date !== new Date(event.date).getTime()) changed.push('moved to a new date');
  if (before.time !== (event.time || '')) changed.push('rescheduled');
  if (before.location !== (event.location || '')) changed.push('moved');

  if (changed.length) {
    const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
    const detail = [event.time, event.location].filter(Boolean).join(' · ');
    await notifyMany(recipients.map((u) => u._id), {
      type: 'event',
      title: `Event updated: ${event.title}`,
      body: `Now ${fmtDate(event.date)}${detail ? ` - ${detail}` : ''}`,
      link: 'calendar',
    });
  }

  res.json({ event, notified: changed.length ? true : false });
});

/**
 * Delete a calendar event by id.
 * @route DELETE /api/events/:id   (HR/SuperAdmin)
 * @param {string} req.params.id - event id
 * @returns {{id: string, deleted: boolean}}
 */
// DELETE /api/events/:id   (HR/SuperAdmin)
const deleteEvent = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    res.status(404);
    throw new Error('Event not found');
  }
  const { title, date } = event;
  await event.deleteOne();

  // A cancellation matters more than the original invitation — without this an
  // attendee only finds out by noticing the entry has vanished from the calendar.
  const recipients = await User.find({ isActive: true, _id: { $ne: req.user._id } }).select('_id');
  await notifyMany(recipients.map((u) => u._id), {
    type: 'event',
    title: `Event cancelled: ${title}`,
    body: `${fmtDate(date)} - this event has been removed from the calendar`,
    link: 'calendar',
  });

  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listEvents, createEvent, updateEvent, deleteEvent };
