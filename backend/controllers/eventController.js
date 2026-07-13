const asyncHandler = require('express-async-handler');
const Event = require('../models/Event');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// GET /api/events?year=YYYY   (any authenticated user)
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

// PUT /api/events/:id   (HR/SuperAdmin)
const updateEvent = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    res.status(404);
    throw new Error('Event not found');
  }
  const { title, date, time, location, description } = req.body;
  if (title !== undefined) event.title = title;
  if (date !== undefined) event.date = date;
  if (time !== undefined) event.time = time;
  if (location !== undefined) event.location = location;
  if (description !== undefined) event.description = description;
  await event.save();
  res.json({ event });
});

// DELETE /api/events/:id   (HR/SuperAdmin)
const deleteEvent = asyncHandler(async (req, res) => {
  const event = await Event.findById(req.params.id);
  if (!event) {
    res.status(404);
    throw new Error('Event not found');
  }
  await event.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listEvents, createEvent, updateEvent, deleteEvent };
