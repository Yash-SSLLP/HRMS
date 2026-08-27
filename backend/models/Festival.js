const mongoose = require('mongoose');

/**
 * Festival — a REMINDER-ONLY calendar entry (Holi, Diwali, Raksha Bandhan,
 * Eid, Christmas, Republic Day …).
 *
 * This is deliberately NOT a Holiday. A festival is purely informational: it
 * paints a chip on the shared calendar and sends everyone a heads-up the day
 * before and a greeting on the day itself (both with the 8 AM IST morning
 * digest — services/celebrationWorker.js). It has:
 *   - no effect on attendance (the day stays a normal working day),
 *   - no effect on payroll or LOP,
 *   - no effect on leave quotas or working-day counts,
 *   - no comp-off and no double-pay rule.
 *
 * That is exactly why it lives in its own collection instead of becoming a new
 * `Holiday.type`. Eleven separate queries across payroll, leave, attendance and
 * the push-reminder worker read the Holiday collection to decide what is a
 * non-working day; a new type there would have had to be excluded from every
 * one of them, and a single missed filter would silently forgive a real absence
 * or shrink the working-day denominator in someone's salary. A separate model
 * makes that class of mistake impossible.
 *
 * If a company holiday already falls on the same calendar day, the festival is
 * suppressed from the calendar feed and from the morning digest — the holiday
 * entry already says it is Diwali, and nobody needs two chips and two pushes for
 * the same day. See controllers/celebrationsController.js and
 * services/celebrationWorker.js.
 */
const festivalSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    date: { type: Date, required: true, index: true },
    // Shown on the calendar chip and prefixed to the notification title.
    emoji: { type: String, trim: true, default: '' },
    description: { type: String, trim: true },
    // Optional custom line for the notification body; falls back to a generic
    // greeting built from the name.
    greeting: { type: String, trim: true },
    // HR can keep a festival on the calendar but stop it from pushing.
    notify: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Festival', festivalSchema);
