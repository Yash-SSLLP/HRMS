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
  REMINDER_PATTERNS,
  MONTHLY_MODES,
  MONTHLY_MODE,
  DEFAULT_LEAD_DAYS,
  isRoutineFrequency,
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
    // A REPEATING rule's shape (2026-09-27) — see config/tasks
    // REMINDER_PATTERN. Absent on a before/after rule and on an older
    // "every 2 hours" one (read as HOURLY).
    pattern: { type: String, enum: REMINDER_PATTERNS, default: undefined },
    /** 'HH:mm' — when a daily / weekly / monthly reminder goes. */
    at: { type: String, default: undefined },
    /** 'HH:mm' — the window an hourly one speaks in. */
    from: { type: String, default: undefined },
    to: { type: String, default: undefined },
    weekdays: { type: [Number], default: undefined },
    monthlyMode: { type: String, enum: MONTHLY_MODES, default: undefined },
    monthDay: { type: Number, min: 1, max: 31, default: undefined },
    nthWeek: { type: Number, default: undefined },
    weekday: { type: Number, min: 0, max: 6, default: undefined },
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
    /** DAILY: every N days, counted from the start date. 2 = alternate days. */
    interval: { type: Number, min: 1, default: 1 },
    /** WEEKLY: which days, as `Date.getDay()` indexes (0 = Sunday). */
    weekdays: { type: [Number], default: undefined },
    /**
     * MONTHLY: on a DATE (`monthDay`) or on the Nth WEEKDAY — "the first
     * Monday", "the last Friday" (`nthWeek` 1–4 or -1, `weekday` 0–6). Added
     * 2026-09-27: *"similar like first Monday of the month (any day we can pick)"*.
     */
    monthlyMode: { type: String, enum: MONTHLY_MODES, default: MONTHLY_MODE.DATE },
    nthWeek: Number,
    weekday: Number,
    /** MONTHLY/YEARLY: which day. 29–31 clamp to the last day of a short month. */
    monthDay: Number,
    /** YEARLY: 1-12, with monthDay. */
    month: Number,
    /** "HH:mm" 24h in portal time — when the occurrence falls due that day. */
    time: { type: String, trim: true, default: '18:00' },
    /**
     * How many days BEFORE it is due an occurrence lands in the doer's list —
     * a month-end task shows up two days early (config/tasks.DEFAULT_LEAD_DAYS,
     * the user's *"for monthly task 2 day before the deadline"*).
     */
    leadDays: { type: Number, min: 0 },
    /**
     * Does each occurrence go through a review? Ignored for DAILY, which is
     * ROUTINE — only ever marked done (config/tasks.isRoutineFrequency).
     */
    requiresApproval: { type: Boolean, default: true },

    /** The first day an occurrence may be minted for (IST midnight of that day). */
    startDate: { type: Date, required: true },
    /** The last. Null = forever. */
    until: Date,
    /**
     * NOTHING DUE BEFORE THIS IS EVER MINTED. Set when the schedule is created
     * and whenever it is switched back on, so a daily 6 pm task set up at 7 pm
     * starts tomorrow instead of arriving already overdue — and a schedule
     * paused for a fortnight does not wake up and hand somebody the fortnight.
     */
    mintFrom: Date,

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

/**
 * The defaults that depend on WHICH shape the schedule is, filled in here so
 * every path that saves one — the Recurring tab, the old assign form's Repeat
 * box, a PATCH from either client — lands on the same values.
 */
recurringTaskSchema.pre('validate', function shapeDefaults(next) {
  if (this.leadDays === undefined || this.leadDays === null) {
    this.leadDays = DEFAULT_LEAD_DAYS[this.frequency] ?? 0;
  }
  if (!Number.isInteger(this.interval) || this.interval < 1) this.interval = 1;
  // A routine (daily) occurrence is only ever marked done — there is nothing to
  // review. Stored false so a reader of the schedule sees what will happen.
  if (isRoutineFrequency(this.frequency)) this.requiresApproval = false;
  next();
});

module.exports = mongoose.model('RecurringTask', recurringTaskSchema);
