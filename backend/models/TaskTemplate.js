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
 * A task worth setting more than once.
 *
 * REWRITTEN 2026-09-21. The version this replaces described a task in RELATIVE
 * terms — "due N working days after the trigger event", with a workflow
 * attached, an evidence contract and a placeholder resolver that turned
 * `{{reportingManager}}` into a person at mint time. It was a small programming
 * language, and the two places it was used had both been filled in by hand.
 *
 * A template here is simply a task with the dates left off. You save one from
 * any task row ("Create template"), and using it opens the assign form already
 * filled in — you pick the people and the deadline, which are the two things
 * that are different every time. Nothing is resolved, substituted or computed.
 *
 * THE DIRECTORY IS THE SAME THING, SHARED. `directory: true` marks a starter
 * template that everybody in the company can see and copy, grouped by the
 * department it belongs to — the ready-to-use library a new manager can work
 * from on day one instead of facing an empty page. Copying one gives you your
 * own editable row; the shared original is never touched. One model rather than
 * two, because "a template" and "a template somebody else wrote" differ by a
 * boolean and nothing else.
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

const taskTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },

    // ===== The task it makes =====
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

    // The ONE relative thing that survived, because it is the one that is
    // genuinely the same every time: "this is always a three-day job". The
    // assign form offers it as a pre-filled deadline the assigner can move.
    dueInDays: { type: Number, min: 0 },

    repeat: {
      type: new mongoose.Schema(
        {
          frequency: { type: String, enum: FREQUENCIES, default: FREQUENCY.ONCE },
          weekdays: { type: [Number], default: undefined },
          monthDay: Number,
          month: Number,
          time: { type: String, trim: true },
        },
        { _id: false }
      ),
      default: () => ({ frequency: FREQUENCY.ONCE }),
    },

    reminders: { type: [reminderSchema], default: [] },

    links: {
      type: [new mongoose.Schema({ url: String, label: String }, { _id: true })],
      default: [],
    },

    // Usual suspects — pre-selected in the picker, never forced. A template
    // that assigns itself to somebody who has since moved teams is worse than
    // one that asks.
    defaultAssignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    defaultLoopUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // ===== Where it lives =====
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    // Whose template this is. A directory row has none.
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    /** A shared starter template rather than somebody's own. See the docblock. */
    directory: { type: Boolean, default: false, index: true },
    /** The directory's grouping — "Sales", "HR", "Accounts". */
    department: { type: String, trim: true, index: true },
    /** The directory's industry filter — "Manufacturing", "Retail". */
    industry: { type: String, trim: true, index: true },

    useCount: { type: Number, default: 0 },
    lastUsedAt: Date,
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// "My templates" and "the directory, by department" — the two lists there are.
taskTemplateSchema.index({ owner: 1, isActive: 1, name: 1 });
taskTemplateSchema.index({ directory: 1, industry: 1, department: 1 });

module.exports = mongoose.model('TaskTemplate', taskTemplateSchema);
