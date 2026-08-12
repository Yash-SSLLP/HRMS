/**
 * Push reminder controller — SuperAdmin-authored recurring push notifications.
 *
 * The two built-in attendance nudges live in Settings (their audiences are
 * computed, not chosen); these are the open-ended ones. Delivery is handled by
 * services/pushReminderWorker.js, which reads these rows on every tick, so an
 * edit takes effect on the next pass with no restart.
 */
const asyncHandler = require('express-async-handler');
const PushReminder = require('../models/PushReminder');
const EmployeeProfile = require('../models/EmployeeProfile');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(n))));

/**
 * Validate + normalise a reminder payload.
 * @throws {Error} with `.status` when the payload cannot be stored
 */
function shape(body, existing = {}) {
  const title = (body.title ?? existing.title ?? '').trim();
  if (!title) {
    const err = new Error('A title is required — it is what the push actually shows.');
    err.status = 400;
    throw err;
  }
  const hour = body.hour ?? existing.hour;
  const minute = body.minute ?? existing.minute;
  if (!Number.isFinite(Number(hour)) || !Number.isFinite(Number(minute))) {
    const err = new Error('A time is required.');
    err.status = 400;
    throw err;
  }
  const audience = body.audience ?? existing.audience ?? 'all';
  const department = (body.department ?? existing.department ?? '').trim();
  if (audience === 'department' && !department) {
    // Storing this would target nobody, which looks identical to a broken
    // reminder — reject it now rather than let it silently never fire.
    const err = new Error('Pick a department, or set the audience to everyone.');
    err.status = 400;
    throw err;
  }
  // Deduped and sorted so "Mon, Mon, Sun" and "Sun, Mon" store identically.
  const days = [...new Set((body.days ?? existing.days ?? [])
    .map((d) => clamp(d, 0, 6))
    .filter((d) => Number.isInteger(d)))].sort();

  return {
    title,
    body: (body.body ?? existing.body ?? '').trim(),
    hour: clamp(hour, 0, 23),
    minute: clamp(minute, 0, 59),
    days,
    audience: audience === 'department' ? 'department' : 'all',
    department: audience === 'department' ? department : '',
    enabled: body.enabled !== undefined ? !!body.enabled : (existing.enabled !== false),
  };
}

/**
 * List every custom reminder, newest first.
 * @route GET /api/push-reminders  (SuperAdmin)
 * @returns {{count, reminders, departments}} departments for the audience picker
 */
const listReminders = asyncHandler(async (req, res) => {
  const reminders = await PushReminder.find({}).sort({ createdAt: -1 }).lean();
  // The picker's options come from the departments employees are actually in,
  // so it can never offer one that would match nobody.
  const departments = (await EmployeeProfile.distinct('department'))
    .filter(Boolean)
    .sort();
  res.json({ count: reminders.length, reminders, departments });
});

/**
 * Create a reminder.
 * @route POST /api/push-reminders  (SuperAdmin)
 * @returns {{reminder}} (201)
 */
const createReminder = asyncHandler(async (req, res) => {
  let payload;
  try {
    payload = shape(req.body);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  const reminder = await PushReminder.create({ ...payload, createdBy: req.user._id });
  res.status(201).json({ reminder });
});

/**
 * Update a reminder.
 * @route PUT /api/push-reminders/:id  (SuperAdmin)
 * @returns {{reminder}}
 */
const updateReminder = asyncHandler(async (req, res) => {
  const existing = await PushReminder.findById(req.params.id);
  if (!existing) {
    res.status(404);
    throw new Error('Reminder not found');
  }
  let payload;
  try {
    payload = shape(req.body, existing.toObject());
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  Object.assign(existing, payload);
  await existing.save();
  res.json({ reminder: existing });
});

/**
 * Delete a reminder.
 * @route DELETE /api/push-reminders/:id  (SuperAdmin)
 * @returns {{id, deleted}}
 */
const deleteReminder = asyncHandler(async (req, res) => {
  const removed = await PushReminder.findByIdAndDelete(req.params.id);
  if (!removed) {
    res.status(404);
    throw new Error('Reminder not found');
  }
  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listReminders, createReminder, updateReminder, deleteReminder };
