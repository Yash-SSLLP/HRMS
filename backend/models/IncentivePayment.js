const mongoose = require('mongoose');

/**
 * One payment of incentive POINTS to one employee, for one month.
 *
 * WHY THIS IS ITS OWN COLLECTION rather than a flag on the day's team:
 * a team-day is shared by several people, and the company does not settle a day
 * — it settles with a PERSON. It also does not always settle in full: somebody
 * with 100 points outstanding may be paid 20 now and the rest later (user
 * decision 2026-09-10), which a boolean cannot express at all.
 *
 * So payments ACCUMULATE. What a person is still owed for a month is what the
 * entries say they earned minus the sum of these rows — never a stored balance,
 * which would drift the moment a team is corrected. Reverse a mistake by
 * deleting the row.
 *
 * Points, not rupees: the whole module counts in points (see
 * models/IncentiveEntry), and what a point is worth is one company-wide number
 * applied outside this module.
 */
const incentivePaymentSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true, index: true },
    // Snapshots, as on IncentiveEntry: a payment has to keep reading correctly
    // after somebody leaves or is renamed.
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    department: { type: String, trim: true },
    // Which company's books this belongs to. Null = shared/legacy; the company
    // wall reads it exactly as it reads IncentiveEntry.company.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },

    // WHICH MONTH this settles, as the first of that month at local noon (the
    // same pinning IncentiveEntry uses, so a date-only value cannot drift a day
    // and a range query is a plain comparison).
    period: { type: Date, required: true, index: true },
    // How many points were paid in THIS transaction. Several rows for the same
    // person and month are normal — that is what a part payment is.
    points: { type: Number, required: true, min: 0 },

    paidAt: { type: Date, default: Date.now },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    paidByName: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// "What has this person been paid for this month?" — the only query the roll-up
// makes, and the one every payment write is read back by.
incentivePaymentSchema.index({ period: 1, employee: 1 });
incentivePaymentSchema.index({ company: 1, period: 1 });

/**
 * The first of a month, at local noon — how `period` is stored.
 * @param {string|Date} value - 'YYYY-MM', 'YYYY-MM-DD', or a Date
 * @returns {Date|null} null when unreadable
 */
function monthStart(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), 1, 12, 0, 0, 0);
  }
  const m = /^(\d{4})-(\d{1,2})/.exec(String(value || '').trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0, 0);
}

/** 'YYYY-MM' for a stored period, for display and for grouping. */
const monthKey = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};

const IncentivePayment = mongoose.model('IncentivePayment', incentivePaymentSchema);

module.exports = IncentivePayment;
module.exports.monthStart = monthStart;
module.exports.monthKey = monthKey;
