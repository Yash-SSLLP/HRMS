const mongoose = require('mongoose');

/**
 * One team's rolling work for ONE DAY, and the incentive it earned.
 *
 * The team is rebuilt every day — a different picker, a different set of members
 * — so this is deliberately NOT a standing "team" record with daily rows hanging
 * off it. Each document is a day's team as it actually stood, with the people
 * frozen into it.
 *
 * THE RULE, in the order it is computed:
 *   sheets rolled  x  points per sheet   =  the TEAM's points for the day
 *   team points    /  people on the team =  each person's points
 *   team points    x  rupees per point   =  what the day is worth in money
 *
 * Four sheets at 4 points is 16 points for the team; a team of four takes 4
 * points each. Money is the LAST step, not the first — people are paid in points
 * and the rupee value of a point is set once, centrally, for every incentive the
 * company runs (Setting.incentive.rupeePerPoint).
 *
 * So the yield is a TEAM figure, not a head figure: a bigger team does not earn
 * more, it takes smaller shares. (It was rupees-per-head until 2026-09-10 and
 * rupees-per-team until points arrived; if a figure ever looks multiplied by the
 * headcount, that is a rule it is remembering.)
 *
 * `sheets` is NULL until somebody fills it in. That is the working day, not an
 * edge case: the team is put together in the morning and how much it rolled is
 * only known in the evening. A day with no figure yet earns nothing and is
 * reported as pending — never as a zero-point day, which would read as "they did
 * no work" rather than "nobody has told us yet".
 *
 * Names and employee codes are SNAPSHOT onto the row, the way RnrAward snapshots
 * its winners. A month-old entry has to keep reading correctly after somebody
 * leaves, changes department or is renamed — and the people picker deliberately
 * stops offering leavers (see utils/peopleOptions on the client), so a live
 * populate alone would leave old rows blank.
 */
const memberSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true },
    // Snapshots, as above. Not a substitute for `employee` — every report groups
    // by the id, never by the name.
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    department: { type: String, trim: true },
  },
  { _id: false }
);

const incentiveEntrySchema = new mongoose.Schema(
  {
    // The working day this team rolled. Pinned to local noon on save (see the
    // hook below) so a date-only value can never drift a day either way.
    date: { type: Date, required: true, index: true },
    // Optional label ("Team A", "Night shift"). The picker is what actually
    // identifies a team on a given day — see the unique index below.
    teamName: { type: String, trim: true, maxlength: 80 },
    // Which company's books this belongs to. Null = shared/legacy, visible to
    // every walled viewer (see utils/employeeScope).
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    // The day's PICKER. Takes an equal share like anybody else (user decision)
    // and is NOT repeated inside `members` — headCount below adds them.
    //
    // Was called `leader` until 2026-09-10; scripts/renameLeaderToPicker.js moved
    // the stored documents and the unique index. Anything still reading `leader`
    // is older than that migration.
    picker: { type: memberSchema, required: true },
    members: { type: [memberSchema], default: [] },

    // How many sheets the team rolled. NULL means "not filled in yet" — see the
    // note in the docblock. Deliberately not `default: 0`: zero is a real answer
    // (a team that rolled nothing) and has to stay distinguishable from no
    // answer at all.
    sheets: { type: Number, default: null, min: 0 },
    // What one sheet is worth in points, ON THIS DAY. A property of this work,
    // so it can differ from whatever another incentive pays per unit.
    pointsPerSheet: { type: Number, required: true, min: 0, default: 4 },
    // What one point was worth in rupees ON THIS DAY. Company-wide (every
    // incentive shares it) but copied here and FROZEN, so re-valuing a point
    // next month cannot silently restate what a team already earned. Same
    // contract pointsPerSheet has.
    rupeePerPoint: { type: Number, required: true, min: 0, default: 1 },

    // Derived, and stored rather than computed on read so exports, summaries and
    // the mobile screen cannot each arrive at a different figure. Kept in step
    // by recalc() below, which every write path calls.
    //
    // The TEAM figures (`teamPoints`, `totalAmount`) are authoritative; a share
    // is the team figure divided by the heads and rounded, so on a total that
    // does not divide cleanly the shares can add up a hair either side of it.
    headCount: { type: Number, default: 0 },
    teamPoints: { type: Number, default: 0 },
    perPersonPoints: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    perPersonAmount: { type: Number, default: 0 },

    // Who closed the day off, and when. The team is created in the morning by one
    // person and the figure filled in the evening — often by another — so "who
    // recorded this" is two questions, not one.
    sheetsFilledAt: { type: Date },
    sheetsFilledByName: { type: String, trim: true },

    // NOTE there is no "paid" flag here. The company settles with a PERSON, not
    // with a day — and not always in full — so payments live in their own
    // collection (models/IncentivePayment) and what is still owed is derived.
    note: { type: String, trim: true, maxlength: 500 },
    // How the row got here — a hand-typed day or a spreadsheet upload.
    source: { type: String, enum: ['Manual', 'Import'], default: 'Manual' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// One team per picker per day. This is what makes a re-uploaded spreadsheet
// idempotent (the importer upserts on it) and what stops the same day's team
// being entered twice by two people, which would pay everybody twice.
incentiveEntrySchema.index({ date: 1, 'picker.employee': 1 }, { unique: true });
// "What did this person earn?" — the query behind every summary and export.
incentiveEntrySchema.index({ 'members.employee': 1, date: -1 });
incentiveEntrySchema.index({ company: 1, date: -1 });

// Round to paise, not to rupees. A float left alone shows up as
// 4.500000000000001 in an export, and a share is a division — it is never exact.
const paise = (n) => Math.round(n * 100) / 100;

/**
 * Recompute every derived figure: the team's points, one equal share of them, and
 * what both are worth in money. The picker counts as a head, so they take the
 * same share as anybody else.
 * @param {object} doc - an IncentiveEntry document (or anything with the fields)
 * @returns {object} the same doc, with the five derived fields set
 */
function recalc(doc) {
  // A pending day (sheets null) has earned nothing yet — `|| 0` covers it.
  const sheets = Math.max(0, Number(doc.sheets) || 0);
  const perSheet = Math.max(0, Number(doc.pointsPerSheet) || 0);
  const perPoint = Math.max(0, Number(doc.rupeePerPoint) || 0);
  const heads = (Array.isArray(doc.members) ? doc.members.length : 0) + (doc.picker ? 1 : 0);

  // Points first — that is what the team actually earns...
  const teamPoints = paise(sheets * perSheet);
  doc.headCount = heads;
  doc.teamPoints = teamPoints;
  doc.perPersonPoints = heads ? paise(teamPoints / heads) : 0;
  // ...and money is the valuation of those points, applied last.
  doc.totalAmount = paise(teamPoints * perPoint);
  doc.perPersonAmount = heads ? paise(doc.totalAmount / heads) : 0;
  return doc;
}

incentiveEntrySchema.pre('save', function normalise(next) {
  if (this.date) {
    const d = new Date(this.date);
    // Local noon — a date-only value stored at UTC midnight renders as the
    // previous day for any viewer behind UTC (same rule as models/Reminder).
    this.date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  }
  recalc(this);
  next();
});

/**
 * Everyone this entry pays, picker first — the shape every report iterates.
 * @param {object} entry - an IncentiveEntry (document or lean object)
 * @returns {Array<{employee: any, name: string, employeeCode: string, department: string, isPicker: boolean}>}
 */
function payees(entry) {
  const out = [];
  if (entry.picker && entry.picker.employee) out.push({ ...(entry.picker.toObject ? entry.picker.toObject() : entry.picker), isPicker: true });
  for (const m of entry.members || []) {
    if (m && m.employee) out.push({ ...(m.toObject ? m.toObject() : m), isPicker: false });
  }
  return out;
}

/**
 * Is this day still waiting for its rolling count?
 * @param {object} entry - an IncentiveEntry (document or lean object)
 * @returns {boolean}
 */
const isPending = (entry) => entry == null || entry.sheets == null;

const IncentiveEntry = mongoose.model('IncentiveEntry', incentiveEntrySchema);

module.exports = IncentiveEntry;
module.exports.recalc = recalc;
module.exports.payees = payees;
module.exports.isPending = isPending;
