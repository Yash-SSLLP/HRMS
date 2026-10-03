/**
 * Event controller — CRUD for company calendar Events. Creating an event fans out
 * an in-app + push notification to all active users. Mutations are HR/SuperAdmin.
 */
const asyncHandler = require('express-async-handler');
const Event = require('../models/Event');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { notifyMany } = require('../services/notify');

// Format a date as e.g. "5 Jan 2026" for notification bodies
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// "2026-10-03" — a calendar day for the audit trail (auditDescribe words it as "3 Oct 2026").
function isoDay(d) {
  if (!d) return '';
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10);
}

// Events carry no status, so the auditStatus plugin never sees them — the trail
// is written here. Best-effort: a failed audit write must never fail the save.
function auditEvent(req, event, field, fromStatus, toStatus) {
  const clip = (v) => (String(v ?? '').length > 200 ? `${String(v).slice(0, 199)}…` : String(v ?? ''));
  return AuditLog.create({
    entity: 'Event',
    entityId: event._id,
    entityLabel: event.title,
    field,
    fromStatus: clip(fromStatus),
    toStatus: clip(toStatus),
    by: req.user._id,
    byName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    byRole: req.user.role,
  }).catch(() => {});
}

/**
 * List events, optionally scoped to a calendar year, sorted by date.
 * @route GET /api/events?year=YYYY   (any authenticated user)
 * @param {string} [req.query.year]
 * @returns {{count: number, events: Object[]}} — createdBy/updatedBy (populated)
 *   only for a Super Admin; everyone else gets the events without them.
 */
const listEvents = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.year) {
    const year = Number(req.query.year);
    filter.date = { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) };
  }
  // Who added / last edited an event is Super Admin-only — the list is read by
  // every employee (calendar), so the names are left out of the query itself.
  const superAdmin = req.user?.role === 'SuperAdmin';
  const query = Event.find(filter).sort({ date: 1 });
  if (superAdmin) {
    query.populate('createdBy', 'firstName lastName role').populate('updatedBy', 'firstName lastName role');
  } else {
    query.select('-createdBy -updatedBy');
  }
  const events = await query;
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
  await auditEvent(req, event, 'status', '', 'Created');

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
  const beforeDay = isoDay(event.date);
  const beforeDescription = event.description || '';

  const { title, date, time, location, description } = req.body;
  if (title !== undefined) event.title = title;
  if (date !== undefined) event.date = date;
  if (time !== undefined) event.time = time;
  if (location !== undefined) event.location = location;
  if (description !== undefined) event.description = description;
  event.updatedBy = req.user._id;
  await event.save();

  // One audit line per field that actually changed (description included —
  // it does not notify anyone, but the record of who rewrote it still counts).
  const edits = [
    ['Title', before.title, event.title],
    ['Date', beforeDay, isoDay(event.date)],
    ['Time', before.time, event.time || ''],
    ['Location', before.location, event.location || ''],
    ['Description', beforeDescription, event.description || ''],
  ].filter(([, from, to]) => from !== to);
  await Promise.all(edits.map(([field, from, to]) => auditEvent(req, event, field, from || '—', to || '—')));

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
  await auditEvent(req, event, 'status', '', 'deleted');

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
