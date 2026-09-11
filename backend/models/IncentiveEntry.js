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
 *   sheets rolled  x  points per sheet      =  the TEAM's points for the day
 *   team points    x  non-rolling share %   =  the cut for everyone else
 *   what is left   /  people on the team    =  each roller's points
 *   the cut        /  non-rollers PRESENT   =  each of their points
 *   team points    x  rupees per point      =  what the day is worth in money
 *
 * Four sheets at 4 points is 16 points for the team; at a 30% share, 4.8 goes to
 * the department and a team of four takes 2.8 points each. Money is the LAST
 * step, not the first — people are paid in points and the rupee value of a point
 * is set once, centrally, for every incentive the company runs
 * (Setting.incentive.rupeePerPoint).
 *
 * THE NON-ROLLING GROUP BELONGS TO THE DAY (user decision 2026-09-11, reversing
 * the per-team rule of the same day). One group is chosen per day, from the
 * people who did NOT roll that day, and it shares in everything rolled on it:
 * every team gives up its own 30% and the whole cut splits equally between the
 * group. Nobody on a rolling team may be in it — they are already paid.
 *
 * It is STORED by mirroring the same list onto every one of the day's entries
 * (see applyDayGroup in controllers/incentiveController.js). That is what keeps
 * the arithmetic below untouched — each entry still computes its own cut from
 * its own points — while making a person's day total a share of each team's
 * cut, which is their equal share of the day. Three teams rolling 40, 40 and 20
 * at 30% hand over 12 + 12 + 6 = 30, which is 30% of the 100 the day rolled.
 * So: do not set `nonRolling` on one entry and not its siblings — the day would
 * then pay the group out of one team only.
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

/**
 * Somebody in the department who did NOT roll that DAY, and takes a cut of what
 * the day's teams earned anyway.
 *
 * The floor does not divide neatly into a rolling team and nobody else: the rest
 * of the department is there all day doing the work that lets the teams roll. So
 * a fixed percentage (`nonRollingSharePct`) comes off the top of every team's
 * points and the whole of it is split equally between these people — but only
 * the ones who were actually THERE, which is what `present` records.
 *
 * The SAME list is on every entry of the day (see the file's docblock), so this
 * array is a copy of the day's group rather than a choice made for this team.
 *
 * PRESENCE DEFAULTS FROM ATTENDANCE AND CAN BE OVERRIDDEN (user decision
 * 2026-09-11). `attendance` keeps the status the record actually had when the
 * group was saved, so an override is visible as an override rather than as a
 * disagreement with the attendance module — and a later attendance correction
 * cannot silently restate a day that has already been paid.
 *
 * An absent person is KEPT on the row rather than dropped. "We considered them
 * and they were not in" is a different statement from "we never listed them",
 * and only the first one survives a question about a day six weeks later.
 */
const nonRollingMemberSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true },
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    department: { type: String, trim: true },
    // Only a present member is paid. Defaults true so a hand-built group
    // behaves the obvious way when attendance has nothing to say.
    present: { type: Boolean, default: true },
    // What Attendance said for this person on this day when the group was saved
    // ('Present', 'Absent', 'OnLeave', …), or null if there was no record at
    // all. Never read back as the answer — `present` is the answer.
    attendance: { type: String, trim: true, default: null },
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
    // The rest of the department, who take a cut of this team's points — see
    // nonRollingMemberSchema above. Empty is the normal state of a day that has
    // only just been put together.
    nonRolling: { type: [nonRollingMemberSchema], default: [] },
    // What percentage of this team's points goes to them, ON THIS DAY. Frozen
    // here exactly as pointsPerSheet and rupeePerPoint are: changing the company
    // figure must never restate a day already recorded, let alone one already
    // paid. Applied ONLY when somebody present is actually listed — otherwise a
    // day with no non-rolling group would quietly burn 30% of its points with
    // nobody to give them to.
    nonRollingSharePct: { type: Number, required: true, min: 0, max: 100, default: 30 },

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
    // The whole pot the day earned, BEFORE the non-rolling cut. It is what the
    // day cost the company, and it is what every "points earned" total counts —
    // splitting it differently must never change it.
    teamPoints: { type: Number, default: 0 },
    // The pot after the cut, and the cut itself. They always add back up to
    // teamPoints, which is the property every report leans on.
    rollingPoints: { type: Number, default: 0 },
    nonRollingPoints: { type: Number, default: 0 },
    // One rolling share: rollingPoints ÷ headCount.
    perPersonPoints: { type: Number, default: 0 },
    // How many non-rolling people were PRESENT, and one of their shares.
    nonRollingHeadCount: { type: Number, default: 0 },
    perNonRollingPoints: { type: Number, default: 0 },
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
 * Recompute every derived figure: the team's points, the cut that goes to the
 * people who did not roll, one equal share of each, and what they are worth in
 * money. The picker counts as a head, so they take the same rolling share as
 * anybody else.
 *
 * The order matters and is the rule the whole module rests on:
 *   sheets × points a sheet      = the TEAM's points (the pot)
 *   pot × nonRollingSharePct     = the non-rolling cut
 *   pot − cut                    = what the rolling team keeps
 *   cut ÷ present non-rollers    = one non-rolling share
 *   (pot − cut) ÷ heads          = one rolling share
 *
 * THE CUT IS ONLY TAKEN WHEN THERE IS SOMEBODY PRESENT TO GIVE IT TO. A day put
 * together in the morning has no non-rolling group yet, and a group where
 * everybody was absent has nobody to pay — in both cases the percentage is zero
 * and the rolling team keeps the lot. Taking it anyway would delete points that
 * nobody ever receives.
 * @param {object} doc - an IncentiveEntry document (or anything with the fields)
 * @returns {object} the same doc, with every derived field set
 */
function recalc(doc) {
  // A pending day (sheets null) has earned nothing yet — `|| 0` covers it.
  const sheets = Math.max(0, Number(doc.sheets) || 0);
  const perSheet = Math.max(0, Number(doc.pointsPerSheet) || 0);
  const perPoint = Math.max(0, Number(doc.rupeePerPoint) || 0);
  const heads = (Array.isArray(doc.members) ? doc.members.length : 0) + (doc.picker ? 1 : 0);
  const presentNonRolling = (Array.isArray(doc.nonRolling) ? doc.nonRolling : [])
    .filter((m) => m && m.employee && m.present !== false).length;

  // Points first — that is what the team actually earns...
  const teamPoints = paise(sheets * perSheet);
  // ...then the cut, which is zero unless somebody is actually there to take it.
  const pct = presentNonRolling
    ? Math.min(100, Math.max(0, Number(doc.nonRollingSharePct) || 0))
    : 0;
  const nonRollingPoints = paise(teamPoints * (pct / 100));
  // Subtraction, not a second multiplication: 70% of a number that does not
  // divide cleanly is not always the pot minus 30% of it, and the two halves
  // have to add back up to the pot exactly.
  const rollingPoints = paise(teamPoints - nonRollingPoints);

  doc.headCount = heads;
  doc.teamPoints = teamPoints;
  doc.rollingPoints = rollingPoints;
  doc.nonRollingPoints = nonRollingPoints;
  doc.nonRollingHeadCount = presentNonRolling;
  doc.perPersonPoints = heads ? paise(rollingPoints / heads) : 0;
  doc.perNonRollingPoints = presentNonRolling ? paise(nonRollingPoints / presentNonRolling) : 0;
  // ...and money is the valuation of those points, applied last. `totalAmount`
  // stays the value of the WHOLE pot — what the day cost — while a head's money
  // follows their own share, which is no longer the pot divided by the heads.
  doc.totalAmount = paise(teamPoints * perPoint);
  doc.perPersonAmount = paise(doc.perPersonPoints * perPoint);
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
 *
 * TWO KINDS OF PAYEE NOW, ON DIFFERENT SHARES, so each one carries its OWN
 * `sharePoints` rather than leaving the caller to reach for `entry.perPersonPoints`.
 * That is the whole reason this returns what it returns: a roll-up that picked
 * the wrong share would pay a non-rolling person a full rolling share, and the
 * mistake would be invisible in every total because the pot still adds up.
 *
 * An ABSENT non-roller is not a payee and is not returned — they are on the
 * entry as a record of having been considered, not as somebody owed anything.
 * @param {object} entry - an IncentiveEntry (document or lean object)
 * @returns {Array<{employee: any, name: string, employeeCode: string,
 *   department: string, isPicker: boolean, isNonRolling: boolean, sharePoints: number}>}
 */
function payees(entry) {
  const plain = (p) => (p.toObject ? p.toObject() : p);
  const rollingShare = entry.perPersonPoints || 0;
  const nonRollingShare = entry.perNonRollingPoints || 0;
  const out = [];
  if (entry.picker && entry.picker.employee) {
    out.push({ ...plain(entry.picker), isPicker: true, isNonRolling: false, sharePoints: rollingShare });
  }
  for (const m of entry.members || []) {
    if (m && m.employee) out.push({ ...plain(m), isPicker: false, isNonRolling: false, sharePoints: rollingShare });
  }
  for (const m of entry.nonRolling || []) {
    if (m && m.employee && m.present !== false) {
      out.push({ ...plain(m), isPicker: false, isNonRolling: true, sharePoints: nonRollingShare });
    }
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
