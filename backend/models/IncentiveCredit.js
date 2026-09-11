const mongoose = require('mongoose');

/**
 * Points handed to one employee DIRECTLY, outside any team-day.
 *
 * The rolling incentive earns points by arithmetic — sheets × points a sheet,
 * split between the heads on the team (models/IncentiveEntry). This is the other
 * way points arrive: somebody decides a person has earned more and credits them.
 * A hard week, standing in on a Sunday, a job nobody counted in sheets.
 *
 * WHY IT IS NOT AN ENTRY WITH ONE PERSON ON IT: an entry is a team's day and
 * carries a picker, a sheet count and a per-sheet yield, all of which would have
 * to be invented to fake a credit — and the day-by-day record, the export and the
 * double-pay check would then all read a bonus as work that was rolled. A credit
 * is its own act, with a REASON attached, and reads as one everywhere.
 *
 * WHY IT IS NOT TIED TO AN INCENTIVE: points are one company-wide currency
 * (Setting.incentive.rupeePerPoint values them, IncentivePayment settles them
 * without naming a module). A credit joins that same pool, which is why every
 * roll-up in this module — the Boys per-employee tab included — has to add it in.
 * A person credited 50 points and then paid 50 would otherwise read as 50 points
 * overpaid.
 *
 * REVERSING ONE IS A DELETE, the way a payment is reversed: what a person is owed
 * is always `earned − paid`, derived, never stored. The controller refuses a
 * delete that would drop somebody below what they have already been paid for that
 * month — that money is gone, and the row is the only record of why.
 *
 * Names and codes are SNAPSHOT, as everywhere else in this module: a credit has
 * to keep reading correctly after somebody leaves, moves department or is
 * renamed.
 */
const incentiveCreditSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true, index: true },
    // Snapshots — see the docblock. Never grouped on: every report keys by id.
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    department: { type: String, trim: true },
    // Which company's books this belongs to. Null = shared/legacy; the company
    // wall reads it exactly as it reads IncentiveEntry.company.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },

    // The day the points are credited FOR, pinned to local noon by the hook
    // below. It is the same instant shape IncentiveEntry.date uses, so one date
    // range filters both — and the month it falls in is the month it is paid in.
    date: { type: Date, required: true, index: true },
    // Always positive. Taking points back is deleting the row, not crediting a
    // negative: a minus figure would net silently into a month's total and leave
    // nothing on screen saying it had happened.
    points: { type: Number, required: true, min: 0 },
    // WHY. Required by the controller, not merely stored: a credit with no
    // reason cannot be audited, and this is the only record of the decision.
    reason: { type: String, trim: true, maxlength: 300 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// "What was this person credited over this range?" — the query behind every
// roll-up on the dashboard.
incentiveCreditSchema.index({ date: -1, employee: 1 });
incentiveCreditSchema.index({ company: 1, date: -1 });

incentiveCreditSchema.pre('save', function normalise(next) {
  if (this.date) {
    const d = new Date(this.date);
    // Local noon — a date-only value stored at UTC midnight renders as the
    // previous day for any viewer behind UTC (same rule as IncentiveEntry).
    this.date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  }
  this.points = Math.round((Number(this.points) || 0) * 100) / 100;
  next();
});

module.exports = mongoose.model('IncentiveCredit', incentiveCreditSchema);
