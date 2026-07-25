/**
 * Reminder controller — dated reminders that appear on the month calendar.
 *
 * Everyone may create reminders for themselves. SuperAdmin / HRManager / CEO / MD
 * may additionally aim one at specific people, a department, or the whole
 * company; those fan out an in-app + push notification linking to the calendar.
 * Editing and deleting is limited to the creator (SuperAdmin may manage any).
 */
const asyncHandler = require('express-async-handler');
const Reminder = require('../models/Reminder');
const { REMINDER_SCOPES, REMINDER_PRIORITIES, BROADCAST_ROLES } = require('../models/Reminder');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { notifyMany } = require('../services/notify');

const CREATOR_FIELDS = 'firstName lastName role';

/** The viewer's own department (from their employee profile), or null. */
async function myDepartment(user) {
  const profile = await EmployeeProfile.findOne({ user: user._id }).select('department').lean();
  return profile?.department || null;
}

/** Whether this user may aim a reminder at anyone other than themselves. */
function canBroadcast(user) {
  return !!user && BROADCAST_ROLES.includes(user.role);
}

/** Format a date as e.g. "5 Jan 2026" for notification bodies. */
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Resolve a reminder's audience to User ids to notify (never the creator).
 * @returns {Promise<string[]>}
 */
async function resolveRecipients(reminder) {
  // `createdBy` may arrive populated (the morning digest populates it for the
  // sender's name), so read through to the id rather than stringifying the doc.
  const exclude = String(reminder.createdBy?._id || reminder.createdBy);
  if (reminder.scope === 'self') return [];

  if (reminder.scope === 'users') {
    return (reminder.recipients || [])
      .map((r) => String(r?._id || r))
      .filter((id) => id !== exclude);
  }

  if (reminder.scope === 'department') {
    if (!reminder.department) return [];
    const profiles = await EmployeeProfile.find({ department: reminder.department })
      .select('user')
      .lean();
    const ids = profiles.map((p) => String(p.user)).filter(Boolean);
    if (!ids.length) return [];
    const active = await User.find({ _id: { $in: ids }, isActive: true }).select('_id');
    return active.map((u) => String(u._id)).filter((id) => id !== exclude);
  }

  // everyone
  const active = await User.find({ isActive: true, _id: { $ne: exclude } }).select('_id');
  return active.map((u) => String(u._id));
}

/** Parse a YYYY-MM-DD (or ISO) date string into a local-noon Date, or null. */
function parseDay(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * List the reminders visible to the caller, optionally limited to one month.
 * @route GET /api/reminders?month=YYYY-MM&mine=1
 * @param {string} [req.query.month] - YYYY-MM; omit for every visible reminder
 * @param {string} [req.query.mine] - '1' to return only the caller's own
 * @returns {{count: number, canBroadcast: boolean, reminders: Object[]}}
 */
const listReminders = asyncHandler(async (req, res) => {
  const filter = req.query.mine === '1'
    ? { createdBy: req.user._id }
    : Reminder.visibleFilter(req.user, await myDepartment(req.user));

  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    const [y, m] = req.query.month.split('-').map(Number);
    if (m >= 1 && m <= 12) {
      filter.date = { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) };
    }
  }

  const reminders = await Reminder.find(filter)
    .populate('createdBy', CREATOR_FIELDS)
    .populate('recipients', CREATOR_FIELDS)
    .sort({ date: 1 });

  res.json({ count: reminders.length, canBroadcast: canBroadcast(req.user), reminders });
});

/**
 * Create a reminder. Non-broadcast roles are forced to scope 'self'.
 * @route POST /api/reminders
 * @param {string} req.body.title - required
 * @param {string} req.body.date - required (YYYY-MM-DD)
 * @param {string} [req.body.scope] - self|users|department|everyone
 * @param {string[]} [req.body.recipients] - user ids, for scope 'users'
 * @param {string} [req.body.department] - for scope 'department'
 * @param {string} [req.body.time] - free text, e.g. "4:00 PM"
 * @param {string} [req.body.notes]
 * @param {string} [req.body.priority] - Low|Normal|High
 * @returns {{reminder: Object, notified: number}} (201)
 * @sideeffect notifies the resolved audience for any scope other than 'self'
 */
const createReminder = asyncHandler(async (req, res) => {
  const { title, date, time, notes, priority } = req.body || {};
  if (!title || !date) {
    res.status(400);
    throw new Error('title and date are required');
  }
  const day = parseDay(date);
  if (!day) {
    res.status(400);
    throw new Error('date is not a valid date');
  }

  // Only privileged roles may target other people — everyone else gets a
  // personal reminder regardless of what the client asked for.
  let scope = REMINDER_SCOPES.includes(req.body.scope) ? req.body.scope : 'self';
  if (!canBroadcast(req.user)) scope = 'self';

  let recipients = [];
  let department = '';
  if (scope === 'users') {
    recipients = Array.isArray(req.body.recipients) ? req.body.recipients.filter(Boolean) : [];
    if (!recipients.length) {
      res.status(400);
      throw new Error('Select at least one person for a "specific people" reminder');
    }
  } else if (scope === 'department') {
    department = (req.body.department || '').trim();
    if (!department) {
      res.status(400);
      throw new Error('department is required for a department reminder');
    }
  }

  const reminder = await Reminder.create({
    title,
    notes,
    date: day,
    time,
    scope,
    recipients,
    department,
    priority: REMINDER_PRIORITIES.includes(priority) ? priority : 'Normal',
    createdBy: req.user._id,
    createdByRole: req.user.role,
  });

  const audience = await resolveRecipients(reminder);
  if (audience.length) {
    const who = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'HR';
    await notifyMany(audience, {
      type: 'reminder',
      // Personal item — show it in both portals for dual-role users.
      audience: 'all',
      title: `Reminder: ${reminder.title}`,
      body: `${fmtDate(reminder.date)}${reminder.time ? ` at ${reminder.time}` : ''} · set by ${who}`,
      link: 'calendar',
    });
  }

  await reminder.populate('createdBy', CREATOR_FIELDS);
  res.status(201).json({ reminder, notified: audience.length });
});

/** Load a reminder and assert the caller may modify it (creator, or SuperAdmin). */
async function loadOwned(req, res) {
  const reminder = await Reminder.findById(req.params.id);
  if (!reminder) {
    res.status(404);
    throw new Error('Reminder not found');
  }
  const isOwner = String(reminder.createdBy) === String(req.user._id);
  if (!isOwner && req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('You can only change reminders you created');
  }
  return reminder;
}

/**
 * Update a reminder (creator, or SuperAdmin). Scope changes still require the
 * broadcast roles; the audience is not re-notified.
 * @route PUT /api/reminders/:id
 * @returns {{reminder: Object}}
 */
const updateReminder = asyncHandler(async (req, res) => {
  const reminder = await loadOwned(req, res);
  const { title, date, time, notes, priority, scope, recipients, department } = req.body || {};

  if (title !== undefined) reminder.title = title;
  if (notes !== undefined) reminder.notes = notes;
  if (time !== undefined) reminder.time = time;
  if (priority !== undefined && REMINDER_PRIORITIES.includes(priority)) reminder.priority = priority;
  if (date !== undefined) {
    const day = parseDay(date);
    if (!day) {
      res.status(400);
      throw new Error('date is not a valid date');
    }
    reminder.date = day;
  }
  if (scope !== undefined && REMINDER_SCOPES.includes(scope) && canBroadcast(req.user)) {
    reminder.scope = scope;
    if (scope === 'users') reminder.recipients = Array.isArray(recipients) ? recipients : reminder.recipients;
    if (scope === 'department') reminder.department = (department || reminder.department || '').trim();
    if (scope === 'self' || scope === 'everyone') { reminder.recipients = []; reminder.department = ''; }
  }

  await reminder.save();
  await reminder.populate('createdBy', CREATOR_FIELDS);
  res.json({ reminder });
});

/**
 * Delete a reminder (creator, or SuperAdmin).
 * @route DELETE /api/reminders/:id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteReminder = asyncHandler(async (req, res) => {
  const reminder = await loadOwned(req, res);
  await reminder.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  myDepartment,
  canBroadcast,
  // Shared with services/celebrationWorker.js so the morning-of digest resolves
  // a reminder's audience exactly the way creation did.
  resolveRecipients,
};
