const mongoose = require('mongoose');

// A dated reminder that shows on the calendar. Anyone can set one for themselves
// (scope 'self'); HR / SuperAdmin / CEO / MD can also push one to specific
// people, a whole department, or the entire company — those fan out a
// notification as well (see controllers/reminderController.js).
//
//   self       → only the creator sees it
//   users      → the creator + everyone in `recipients`
//   department → the creator + every employee whose profile department matches
//   everyone   → all authenticated users
const REMINDER_SCOPES = ['self', 'users', 'department', 'everyone'];
const REMINDER_PRIORITIES = ['Low', 'Normal', 'High'];

const reminderSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000 },
    // The calendar day the reminder lands on. Normalised to local noon on save so
    // it can never drift to the previous/next day through a timezone conversion.
    date: { type: Date, required: true, index: true },
    time: { type: String, trim: true }, // optional free text, e.g. "4:00 PM" (matches Event)
    scope: { type: String, enum: REMINDER_SCOPES, default: 'self', index: true },
    recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],
    department: { type: String, trim: true },
    priority: { type: String, enum: REMINDER_PRIORITIES, default: 'Normal' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Role snapshot at creation time, so the calendar can still say "set by HR"
    // after the person's role changes or their account is deactivated.
    createdByRole: { type: String, trim: true },
  },
  { timestamps: true }
);

// Pin the stored instant to midday local time — a date-only value saved as UTC
// midnight would render as the previous day for any viewer behind UTC.
reminderSchema.pre('save', function normaliseDate(next) {
  if (this.date) {
    const d = new Date(this.date);
    this.date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  }
  next();
});

/**
 * Mongo filter for the reminders a given viewer is allowed to see. Used by both
 * the reminders API and the month calendar so the two can never disagree.
 * @param {object} user - the viewing User doc
 * @param {string|null} department - the viewer's own department, if known
 * @returns {object} filter fragment to merge into a Reminder query
 */
reminderSchema.statics.visibleFilter = function visibleFilter(user, department) {
  const or = [
    { createdBy: user._id },                          // covers scope 'self'
    { scope: 'everyone' },
    { scope: 'users', recipients: user._id },
  ];
  if (department) or.push({ scope: 'department', department });
  return { $or: or };
};

// Roles allowed to aim a reminder at other people. CEO/MD are read-only
// executives everywhere else, but setting company reminders is explicitly part
// of their job here.
const BROADCAST_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD'];

module.exports = mongoose.model('Reminder', reminderSchema);
module.exports.REMINDER_SCOPES = REMINDER_SCOPES;
module.exports.REMINDER_PRIORITIES = REMINDER_PRIORITIES;
module.exports.BROADCAST_ROLES = BROADCAST_ROLES;
