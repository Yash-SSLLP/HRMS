const mongoose = require('mongoose');
const IncentiveEntry = require('./IncentiveEntry');

/**
 * One day's QC (quality check) in the Boys incentive, and the points it earned.
 *
 * QC works the way a rolling team does (user decision 2026-09-26): a MANAGER —
 * Admin, the tab's manager, HR, CEO, MD — sets who is doing QC that day in the
 * morning, one person or several, and fills in the sheet count in the evening.
 * The same rule then applies:
 *
 *   sheets     x  points per sheet  =  the GROSS
 *   gross      x  deduction %       =  the company's cut, paid to nobody
 *   what is left / the QC people    =  each one's points
 *
 * at QC's OWN figures — 4 points a sheet and 30% off by default, set on the
 * Points per sheet tab and frozen onto the day, so changing them never restates
 * a day already recorded.
 *
 * WHY A COLLECTION OF ITS OWN rather than a kind of IncentiveEntry. A team-day
 * is keyed on its picker (a unique index, the importer's upsert and the
 * one-team-per-picker rule all read it) and QC has no picker; its sheets are not
 * sheets ROLLED, so every "Sheet Rolled" total would double-count them; and the
 * double-booking guard between teams has nothing to say about QC. Keeping it
 * apart leaves the daily teams untouched.
 *
 * THE SHAPE IS THE ENTRY'S ON PURPOSE. The QC people live in `members` and the
 * derived figures carry the entry's names, so IncentiveEntry.payees() and
 * isPending() read a QC day unchanged: every roll-up in the points pool (the
 * per-employee tab, the dashboard, payments, My Incentive, the leaderboard)
 * adds it with the same loop it uses for teams. A roll-up that forgets to fetch
 * QC days quietly under-pays the QC people — see qcDaysIn in the controller,
 * which is the one way they are fetched.
 */
const personSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true },
    // Snapshots, as on a team-day: a month-old QC day must still read correctly
    // after somebody leaves or is renamed.
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    department: { type: String, trim: true },
  },
  { _id: false }
);

const incentiveQcDaySchema = new mongoose.Schema(
  {
    // The working day, pinned to local noon on save like a team-day.
    date: { type: Date, required: true, index: true },
    // Which company's books this belongs to — the first QC person's, the same
    // way a team-day takes its picker's. Null = shared/legacy.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    // Who did QC that day. Everyone here takes an equal share. `members`, not a
    // new name, so the entry helpers read it — see the docblock.
    members: {
      type: [personSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'Choose who is doing QC'],
    },

    // How many sheets QC is credited with. NULL until the evening — never 0,
    // which would claim QC checked nothing.
    sheets: { type: Number, default: null, min: 0 },
    // QC's own figures, frozen on the day.
    pointsPerSheet: { type: Number, required: true, min: 0, default: 4 },
    deductionPct: { type: Number, required: true, min: 0, max: 100, default: 30 },
    rupeePerPoint: { type: Number, required: true, min: 0, default: 1 },

    // Derived by IncentiveEntry.recalc — the same arithmetic as a team-day.
    headCount: { type: Number, default: 0 },
    grossPoints: { type: Number, default: 0 },
    deductionPoints: { type: Number, default: 0 },
    // What QC is credited with — gross less the deduction — and the figure
    // every roll-up reads.
    teamPoints: { type: Number, default: 0 },
    perPersonPoints: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    perPersonAmount: { type: Number, default: 0 },

    // Who closed the day off, and when — usually not who opened it.
    sheetsFilledAt: { type: Date },
    sheetsFilledByName: { type: String, trim: true },

    note: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// "What did this person earn?" — the query behind every roll-up.
incentiveQcDaySchema.index({ 'members.employee': 1, date: -1 });
incentiveQcDaySchema.index({ company: 1, date: -1 });

incentiveQcDaySchema.pre('save', function normalise(next) {
  if (this.date) {
    const d = new Date(this.date);
    this.date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  }
  IncentiveEntry.recalc(this);
  next();
});

const IncentiveQcDay = mongoose.model('IncentiveQcDay', incentiveQcDaySchema);

module.exports = IncentiveQcDay;
