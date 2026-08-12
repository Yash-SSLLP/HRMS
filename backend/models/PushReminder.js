const mongoose = require('mongoose');

/**
 * A SuperAdmin-authored recurring push reminder.
 *
 * The two built-in attendance nudges (punch-in / punch-out) stay in Settings —
 * they have bespoke audience logic (who has not punched in, who is still
 * checked in) that no generic row could express. These are the open-ended ones:
 * a title, a message, a time, and who gets it.
 *
 * Fired by services/pushReminderWorker.js, which applies the same firing window
 * and once-per-day claim as the built-ins, so a restart cannot replay one.
 */
const AUDIENCES = ['all', 'department'];

const pushReminderSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    // Optional second line. The push shows title alone when this is empty.
    body: { type: String, trim: true, maxlength: 240, default: '' },

    // IST, like every other schedule in the app.
    hour: { type: Number, required: true, min: 0, max: 23 },
    minute: { type: Number, required: true, min: 0, max: 59 },

    // Weekdays it runs on, 0 = Sunday. EMPTY MEANS EVERY DAY — that is the
    // common case, and storing all seven would make "every day" and "happens to
    // include every day" indistinguishable when the set is edited later.
    days: { type: [Number], default: [] },

    audience: { type: String, enum: AUDIENCES, default: 'all' },
    // Only meaningful when audience === 'department'.
    department: { type: String, trim: true, default: '' },

    enabled: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Set by the worker after each send, so the list can show when it last ran
    // rather than leaving an operator guessing whether it fires at all.
    lastSentAt: { type: Date, default: null },
    lastSentCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushReminder', pushReminderSchema);
module.exports.AUDIENCES = AUDIENCES;
