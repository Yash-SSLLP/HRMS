const mongoose = require('mongoose');

/**
 * Time somebody spent on a task (section 11).
 *
 * One row per stretch of work: a timer that was started and stopped, or an entry
 * typed in afterwards. The task carries the ROLL-UP (`Task.minutesLogged` and
 * the per-assignee figure) so no list view has to sum this collection, but the
 * rows here are the record and the roll-up is always recomputed from them —
 * never incremented, which is the mistake that makes a balance drift the first
 * time an entry is corrected.
 *
 * PAUSING DOES NOT CLOSE THE ROW. A person starts at 10:00, pauses for a fifteen
 * minute call and stops at 11:30: that is ONE entry of 1h 15m, not two of 45 and
 * 30 minutes, because the work was one sitting and the break is a fact about it.
 * `pauses` records each gap; `activeMinutes` is elapsed minus the gaps, and is
 * the only figure anything reports on.
 *
 * ONE RUNNING TIMER PER PERSON. Section 11 asks that overlapping timers be
 * prevented "unless explicitly supported by configuration". The partial unique
 * index below does it in the database rather than in a handler: two phones
 * starting a timer in the same second cannot both win, whatever the controller
 * checks first.
 */

const SOURCE = ['timer', 'manual'];
const ENTRY_STATUS = ['running', 'paused', 'stopped'];

const pauseSchema = new mongoose.Schema(
  { at: { type: Date, required: true }, until: Date },
  { _id: false }
);

const timeEntrySchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, trim: true },

    // Server-stamped for a timer; supplied by the person for a manual entry,
    // where it is the honest thing to do — they are telling us about work that
    // has already happened — and where an approver can be required (below).
    startedAt: { type: Date, required: true },
    endedAt: Date,
    pauses: [pauseSchema],

    // Minutes of actual work: elapsed, less every closed pause. Recomputed on
    // save from the stamps above, so it can never disagree with them.
    activeMinutes: { type: Number, default: 0 },
    breakMinutes: { type: Number, default: 0 },

    source: { type: String, enum: SOURCE, default: 'timer' },
    status: { type: String, enum: ENTRY_STATUS, default: 'running', index: true },
    note: { type: String, trim: true, maxlength: 500 },

    // The IST day this entry belongs to, as 'YYYY-MM-DD'. Stored because a
    // timesheet is read by day and a range query on a timestamp cannot answer
    // "which day was this?" for a night shift without re-deriving the timezone
    // on every row.
    dayKey: { type: String, trim: true, index: true },

    // ===== Approval, for manual entries (section 11) =====
    // A timer records itself; a typed figure is a claim. Whether it needs a
    // supervisor's yes is a task/org setting, so this stays null on entries that
    // never needed one.
    approvalStatus: { type: String, trim: true, default: null }, // null | 'Pending' | 'Approved' | 'Rejected'
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    approvalNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// A person's timesheet for a day, and the roll-up per task.
timeEntrySchema.index({ user: 1, dayKey: -1 });
timeEntrySchema.index({ task: 1, user: 1 });
timeEntrySchema.index({ task: 1, startedAt: -1 });
// THE OVERLAP GUARD. Partial, so it only constrains rows that are actually
// live: one running-or-paused entry per person, enforced by the database.
timeEntrySchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['running', 'paused'] } } }
);

/**
 * Elapsed and break minutes for an entry, as of `asOf`.
 *
 * Exported as a plain function as well as running on save, because a RUNNING
 * entry has no `endedAt` and the clients still have to show a live figure — the
 * same arithmetic has to answer "how long so far?" without writing anything.
 * @param {object} doc - a time entry (document or lean)
 * @param {Date} [asOf]
 * @returns {{activeMinutes:number, breakMinutes:number, elapsedMinutes:number}}
 */
function measure(doc, asOf = new Date()) {
  if (!doc || !doc.startedAt) return { activeMinutes: 0, breakMinutes: 0, elapsedMinutes: 0 };
  const start = new Date(doc.startedAt).getTime();
  const end = doc.endedAt ? new Date(doc.endedAt).getTime() : asOf.getTime();
  const elapsedMs = Math.max(0, end - start);

  let breakMs = 0;
  for (const p of doc.pauses || []) {
    if (!p || !p.at) continue;
    const from = new Date(p.at).getTime();
    // An open pause runs to now (or to the end, if the entry was stopped while
    // paused — which the stop path closes, but a crashed process might not).
    const to = p.until ? new Date(p.until).getTime() : Math.min(end, asOf.getTime());
    if (to > from) breakMs += to - from;
  }
  breakMs = Math.min(breakMs, elapsedMs);

  return {
    activeMinutes: Math.round((elapsedMs - breakMs) / 60000),
    breakMinutes: Math.round(breakMs / 60000),
    elapsedMinutes: Math.round(elapsedMs / 60000),
  };
}

timeEntrySchema.pre('save', function computeMinutes(next) {
  const m = measure(this);
  this.activeMinutes = m.activeMinutes;
  this.breakMinutes = m.breakMinutes;
  if (!this.dayKey && this.startedAt) {
    const { istDateString } = require('../utils/istDate');
    this.dayKey = istDateString(this.startedAt);
  }
  next();
});

const TaskTimeEntry = mongoose.model('TaskTimeEntry', timeEntrySchema);

module.exports = TaskTimeEntry;
module.exports.measure = measure;
module.exports.SOURCE = SOURCE;
module.exports.ENTRY_STATUS = ENTRY_STATUS;
