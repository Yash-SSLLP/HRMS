const mongoose = require('mongoose');
const {
  TASK_PRIORITY,
  LEGACY_PRIORITY_MAP,
  DEFAULT_PRIORITY,
  DEFAULT_TASK_POINTS,
  MAX_TASK_POINTS,
  FREQUENCY,
  FREQUENCIES,
  REMINDER_CHANNELS,
  REMINDER_UNITS,
  REMINDER_WHENS,
} = require('../config/tasks');

/**
 * A task that comes back — the schedule, not the tasks.
 *
 * REWRITTEN 2026-09-21, alongside the rest of the module. "90% of the tasks you
 * give are repetitive": the daily invoice, Friday's sales report, the monthly
 * stock count. Ticking Repeat on the assign form creates one of these, and the
 * worker (services/taskRecurrenceWorker) mints an ordinary Task for each
 * occurrence as it comes due. Those tasks point back here through
 * `Task.recurringTask` and are otherwise completely normal — they are worked,
 * scored and reported exactly like a one-off, which is the point: nothing in
 * the rest of the module needs to know recurrence exists.
 *
 * THE OCCURRENCE KEY IS THE WHOLE SAFETY MECHANISM. Every minted task carries
 * `occurrenceKey` — the IST day it is FOR — under a unique compound index with
 * `recurringTask`. A worker that restarts, a server that runs two instances, a
 * catch-up sweep over a week the machine was down: all of them try to insert a
 * key that already exists and get a duplicate-key error instead of a second
 * copy of Monday's task. Idempotence by database constraint rather than by
 * remembering to check, which is the only kind that survives.
 *
 * A SCHEDULE HOLDS THE TASK'S CONTENT, INCLUDING ITS VOICE NOTE. The recording
 * the assigner made once is copied onto every occurrence — explaining the
 * weekly report once is the entire saving.
 */

const reminderSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: REMINDER_CHANNELS, default: 'APP' },
    amount: { type: Number, min: 0, default: 1 },
    unit: { type: String, enum: REMINDER_UNITS, default: 'DAYS' },
    when: { type: String, enum: REMINDER_WHENS, default: 'BEFORE' },
  },
  { _id: false }
);

const recurringTaskSchema = new mongoose.Schema(
  {
    // ===== What each occurrence looks like =====
    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, trim: true, maxlength: 5000 },
    category: { type: String, trim: true },
    // The legacy words are accepted on write and normalised by the controller,
    // the same bargain the Task's own priority makes: a template saved before
    // 2026-09-22 says `High`, and refusing it outright would make an old row
    // unsaveable rather than merely out of date.
    priority: {
      type: String,
      enum: [...TASK_PRIORITY, ...Object.keys(LEGACY_PRIORITY_MAP)],
      default: DEFAULT_PRIORITY,
    },
    points: { type: Number, min: 0, max: MAX_TASK_POINTS, default: DEFAULT_TASK_POINTS },

    assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    loopUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Who set the schedule up on `createdBy`'s behalf, copied onto every
    // occurrence (see Task.onBehalf), so the person who typed it in can follow
    // next week's as well as this one.
    onBehalf: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byName: { type: String, trim: true },
      at: Date,
    },

    // Copied onto every occurrence. See the docblock.
    voiceNote: {
      type: new mongoose.Schema(
        {
          storagePath: { type: String, required: true },
          mimeType: { type: String, trim: true, default: 'audio/webm' },
          sizeBytes: Number,
          durationMs: Number,
          recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          recordedByName: { type: String, trim: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    links: {
      type: [new mongoose.Schema({ url: String, label: String }, { _id: true })],
      default: [],
    },
    reminders: { type: [reminderSchema], default: [] },

    // ===== The schedule =====
    frequency: { type: String, enum: FREQUENCIES, default: FREQUENCY.DAILY, required: true },
    /** WEEKLY: which days, as `Date.getDay()` indexes (0 = Sunday). */
    weekdays: { type: [Number], default: undefined },
    /** MONTHLY: which day. 29–31 clamp to the last day of a short month. */
    monthDay: Number,
    /** YEARLY: 1-12, with monthDay. */
    month: Number,
    /** "HH:mm" 24h in portal time — when the occurrence falls due that day. */
    time: { type: String, trim: true, default: '18:00' },

    /** The first day an occurrence may be minted for. */
    startDate: { type: Date, required: true },
    /** The last. Null = forever. */
    until: Date,

    // ===== Bookkeeping =====
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    createdByName: { type: String, trim: true },

    isActive: { type: Boolean, default: true, index: true },
    lastRunAt: Date,
    /** The last occurrence key minted, so a catch-up knows where it left off. */
    lastOccurrenceKey: { type: String, trim: true },
    generatedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// The worker's sweep: every live schedule, cheapest first.
recurringTaskSchema.index({ isActive: 1, startDate: 1 });

module.exports = mongoose.model('RecurringTask', recurringTaskSchema);
