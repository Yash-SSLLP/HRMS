const mongoose = require('mongoose');
const { RECURRENCE_FREQUENCIES } = require('../config/taskWorkflow');

/**
 * A task that should exist again and again (section 23).
 *
 * "Monthly attendance audit, every 1st" is one of these; the twelve tasks it
 * makes in a year are twelve ordinary Tasks, each with its own code, its own
 * deadline and its own history, pointing back here through
 * `Task.recurringTask`.
 *
 * THE GENERATOR CANNOT DOUBLE-MINT. `services/taskRecurrenceWorker.js` wakes
 * periodically and creates whatever is due; a restart mid-sweep, two instances
 * of the API, or a clock stepping backwards would all otherwise be a way to
 * create the same month's task twice. Every generated task carries an
 * `occurrenceKey` — the IST day the occurrence is FOR — and Task has a unique
 * index on (recurringTask, occurrenceKey). The database refuses the duplicate,
 * so idempotence does not depend on the worker being careful.
 *
 * WHAT IT MAKES comes from a TaskTemplate, not from fields duplicated here.
 * Recurrence is a schedule, and a template is a shape; keeping them apart means
 * a schedule can be changed without re-describing the work, and one template can
 * feed several schedules.
 */

const recurringSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskTemplate', required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },

    frequency: { type: String, enum: RECURRENCE_FREQUENCIES, required: true },
    // Every N of the frequency — every 2 weeks, every 3 months.
    interval: { type: Number, default: 1, min: 1 },
    // weekly: 0–6, Sunday first (matches Date.getDay).
    daysOfWeek: [{ type: Number, min: 0, max: 6 }],
    // monthly / quarterly / yearly: which day of the month. 31 on a short month
    // lands on the last day rather than skipping — see nextOccurrence.
    dayOfMonth: { type: Number, min: 1, max: 31 },
    // yearly: 0–11.
    monthOfYear: { type: Number, min: 0, max: 11 },
    // custom: a plain list of IST day keys ('YYYY-MM-DD'), for a schedule no
    // rule describes. Kept sorted; days in the past are simply never due.
    customDays: [{ type: String, trim: true }],

    // IST time of day the instance is created, 'HH:mm'. The task's own start and
    // due dates come from the template's relative offsets.
    atTime: { type: String, trim: true, default: '09:00' },

    startsOn: { type: Date, required: true },
    // Null = forever.
    endsOn: Date,
    // Stop after this many instances. Null = no limit.
    maxOccurrences: Number,
    generatedCount: { type: Number, default: 0 },

    // How far ahead the worker may create an instance. A monthly audit that
    // appears on somebody's list a week early is useful; one that appears three
    // months early is noise.
    leadDays: { type: Number, default: 0, min: 0 },

    // Bookkeeping so the sweep is cheap: which occurrence was last made, and
    // when the next one is due. `nextRunAt` is what the worker's query filters
    // on, so a hundred dormant schedules cost one indexed lookup.
    lastOccurrenceKey: { type: String, trim: true },
    lastGeneratedAt: Date,
    nextRunAt: { type: Date, index: true },

    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Filled in when the subject of the recurring task is fixed — "Rahul's
    // weekly report". Left empty when the template resolves its own people.
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

recurringSchema.index({ active: 1, nextRunAt: 1 });

/**
 * The next occurrence at or after `from`, as a Date at the schedule's time of
 * day, or null when the schedule has run out.
 *
 * Pure and exported, so the worker, the API (which shows "next: 1 Oct") and the
 * test harness all answer the question the same way.
 *
 * THE SHORT-MONTH RULE. A schedule set to the 31st must still fire in February.
 * Skipping it would silently drop two months a year from a compliance task, so
 * the day is CLAMPED to the last day of the month — the 31st in February is the
 * 28th, which is what a person means by "the last day of the month".
 *
 * @param {object} rule - a RecurringTask (document or lean)
 * @param {Date} [from] - look from this instant forward
 * @returns {Date|null}
 */
function nextOccurrence(rule, from = new Date()) {
  if (!rule || !rule.frequency) return null;
  const [hh, mm] = String(rule.atTime || '09:00').split(':').map((n) => Number(n) || 0);
  const start = rule.startsOn ? new Date(rule.startsOn) : new Date();
  // Never look before the schedule starts.
  const floor = new Date(Math.max(from.getTime(), start.getTime()));
  const end = rule.endsOn ? new Date(rule.endsOn) : null;
  const step = Math.max(1, rule.interval || 1);

  const at = (y, m, d) => new Date(y, m, d, hh, mm, 0, 0);
  const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();
  const done = (d) => (end && d.getTime() > end.getTime() ? null : d);

  if (rule.frequency === 'custom') {
    const days = [...(rule.customDays || [])].sort();
    for (const key of days) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
      if (!m) continue;
      const d = at(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (d.getTime() >= floor.getTime()) return done(d);
    }
    return null;
  }

  if (rule.frequency === 'daily') {
    // Count whole days from the start so `interval` means what it says —
    // "every 3 days" from the 1st is the 4th, not the next multiple of 3.
    const startDay = at(start.getFullYear(), start.getMonth(), start.getDate());
    const dayMs = 86400000;
    const elapsed = Math.max(0, Math.ceil((floor.getTime() - startDay.getTime()) / dayMs));
    const n = Math.ceil(elapsed / step) * step;
    let d = new Date(startDay.getTime() + n * dayMs);
    if (d.getTime() < floor.getTime()) d = new Date(d.getTime() + step * dayMs);
    return done(d);
  }

  if (rule.frequency === 'weekly') {
    const wanted = (rule.daysOfWeek && rule.daysOfWeek.length)
      ? [...new Set(rule.daysOfWeek)].sort((a, b) => a - b)
      : [start.getDay()];
    // Walk forward a day at a time — at most 7 × interval iterations, and it
    // keeps the interval anchored to the START week rather than to the epoch.
    const startWeek = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
    for (let i = 0; i < 7 * step * 2 + 14; i += 1) {
      const d = new Date(floor.getFullYear(), floor.getMonth(), floor.getDate() + i, hh, mm, 0, 0);
      if (d.getTime() < floor.getTime()) continue;
      if (!wanted.includes(d.getDay())) continue;
      const weekOf = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
      const weeks = Math.round((weekOf - startWeek) / (7 * 86400000));
      if (weeks % step !== 0) continue;
      return done(d);
    }
    return null;
  }

  // monthly / quarterly / yearly
  const monthStep = rule.frequency === 'yearly' ? 12 * step
    : rule.frequency === 'quarterly' ? 3 * step
      : step;
  const wantedDay = rule.dayOfMonth || start.getDate();
  const anchorMonth = rule.frequency === 'yearly' && rule.monthOfYear != null
    ? rule.monthOfYear
    : start.getMonth();

  let y = start.getFullYear();
  let m = anchorMonth;
  // Jump roughly to the right place, then step — cheaper than iterating from
  // the start date on a schedule that began years ago.
  const monthsApart = (floor.getFullYear() - y) * 12 + (floor.getMonth() - m);
  if (monthsApart > 0) {
    const jumps = Math.floor(monthsApart / monthStep);
    m += jumps * monthStep;
    y += Math.floor(m / 12);
    m %= 12;
  }
  for (let i = 0; i < 64; i += 1) {
    const d = at(y, m, Math.min(wantedDay, lastDayOf(y, m)));
    if (d.getTime() >= floor.getTime()) return done(d);
    m += monthStep;
    y += Math.floor(m / 12);
    m %= 12;
  }
  return null;
}

/** The IST day key an occurrence belongs to — the generator's idempotence key. */
function occurrenceKeyFor(date) {
  const { istDateString } = require('../utils/istDate');
  return istDateString(date);
}

recurringSchema.methods.next = function next(from) {
  return nextOccurrence(this, from);
};

recurringSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'RecurringTask',
  fields: ['active'],
  label: (d) => d.name,
});

module.exports = mongoose.model('RecurringTask', recurringSchema);
module.exports.nextOccurrence = nextOccurrence;
module.exports.occurrenceKeyFor = occurrenceKeyFor;
