const mongoose = require('mongoose');
const OFFICE = require('../config/office');
const {
  DEFAULT_LATE_POLICY, MAX_GRACE_MINUTES, DEFAULT_MIN_PRESENT_HOURS, HALF_DAY_MIN_HOURS,
  DEFAULT_LATE_ALLOWANCE, MAX_LATE_ALLOWANCE,
} = require('../utils/workday');

// The signature slots a letter can carry. Fixed rather than free-form so a
// renderer can ask for a specific one ("the CEO signs appointment letters")
// without depending on upload order. Extend here to add a slot.
const SIGNATURE_KEYS = ['ceo', 'md', 'hr'];
const SIGNATURE_LABELS = { ceo: 'CEO', md: 'Managing Director', hr: 'Human Resources' };

// Single organization-wide settings document. Currently holds the attendance
// geofence config (office location + how far a punch may be from it). HR /
// SuperAdmin edit these from the admin Attendance page.
const settingSchema = new mongoose.Schema(
  {
    // Fixed key so there is always exactly one settings document.
    singleton: { type: String, default: 'global', unique: true, index: true },
    office: {
      lat: { type: Number, default: OFFICE.lat },
      lng: { type: Number, default: OFFICE.lng },
      label: { type: String, default: OFFICE.label },
    },
    // Punches farther than this from the office are flagged for HR review.
    geofenceThresholdM: { type: Number, default: 200, min: 0 },
    // When false (default), CEO/MD executive accounts are hidden from the
    // "select an employee" pickers that opt in (?excludeExecutives=true). A
    // SuperAdmin can flip this on to make them selectable everywhere.
    includeExecutivesInLists: { type: Boolean, default: false },
    // Does an employee's cash-advance request need an executive sanction before
    // it reaches the people who handle cash?
    //
    // On (the default) a request parks as 'AwaitingApproval' and only a CEO, MD
    // or SuperAdmin can release it into the operators' queue. Off, it goes
    // straight to the operators exactly as it used to. A SuperAdmin flips this
    // from Admin -> Permissions.
    //
    // The flag is read when a request is RAISED and stamped onto the entry
    // (KhataEntry.execApprovalRequired), so turning it off does not silently
    // strand requests already sitting with an executive, and turning it on does
    // not retroactively invalidate ones raised while it was off.
    khataAdvanceApprovalRequired: { type: Boolean, default: true },

    // Org-wide switch for the chat module. Off by default: the launcher, dock
    // and mobile Chat tab are hidden and the chat endpoints refuse writes.
    // Conversations are never deleted — turning it back on restores everything.
    chatEnabled: { type: Boolean, default: false },

    // Daily push reminders (services/attendanceReminderWorker.js), each with its
    // own IST time so a SuperAdmin can move them without a deploy. Stored as
    // hour+minute rather than a string so the worker never has to parse, and
    // clamped by the schema so a bad value can't stop the worker firing.
    // punchOut defaults to WORKDAY_END_HOUR (19:00) — the same hour
    // attendanceWorker assumes a missing punch-out closed at.
    attendanceReminders: {
      punchIn: {
        enabled: { type: Boolean, default: true },
        hour: { type: Number, default: 9, min: 0, max: 23 },
        minute: { type: Number, default: 45, min: 0, max: 59 },
      },
      punchOut: {
        enabled: { type: Boolean, default: true },
        hour: { type: Number, default: 19, min: 0, max: 23 },
        minute: { type: Number, default: 0, min: 0, max: 59 },
      },
    },

    // When a check-in starts counting as late. SuperAdmin-only (it decides
    // money — payroll charges ₹200/₹400 for every late day past the monthly
    // allowance), edited from Admin → Attendance → Office & Geofence.
    //
    // `graceMinutes` is a forgiveness window on top of hour:minute, not a later
    // start time: arriving inside it is not late, arriving past it is late from
    // hour:minute. Defaults reproduce the old hard-coded 10:00 AM / no grace, so
    // an untouched deployment keeps behaving exactly as before.
    //
    // utils/workday.js holds the copy this process actually reads; see
    // services/latePolicy.js for how the two are kept in step.
    latePolicy: {
      hour: { type: Number, default: DEFAULT_LATE_POLICY.hour, min: 0, max: 23 },
      minute: { type: Number, default: DEFAULT_LATE_POLICY.minute, min: 0, max: 59 },
      graceMinutes: { type: Number, default: DEFAULT_LATE_POLICY.graceMinutes, min: 0, max: MAX_GRACE_MINUTES },
    },

    // The least a day has to run before it counts as worked at all. Under it the
    // day is marked Absent, which payroll charges as loss of pay — so like
    // latePolicy above this is SuperAdmin-only, and for the same reason: it
    // applies to everyone and it costs money.
    //
    // Capped at HALF_DAY_MIN_HOURS so the bands stay ordered (a floor above the
    // half-day line would swallow that band whole); 0 switches the rule off.
    // utils/workday.js holds the copy this process reads — services/latePolicy.js
    // keeps the two in step, the same way it does for latePolicy.
    minPresentHours: {
      type: Number,
      default: DEFAULT_MIN_PRESENT_HOURS,
      min: 0,
      max: HALF_DAY_MIN_HOURS,
    },

    // How many late arrivals a month are free before payroll charges for them.
    // SuperAdmin-only for the same reason as the two above: one number, everyone,
    // and it comes straight off somebody's salary. Was a hardcoded 5 in three
    // separate files until it moved here. utils/workday.js holds the copy payroll
    // reads; services/latePolicy.js keeps the two in step.
    lateAllowance: {
      type: Number,
      default: DEFAULT_LATE_ALLOWANCE,
      min: 0,
      max: MAX_LATE_ALLOWANCE,
    },

    // How many attendance regularizations one employee may raise for any single
    // month. 0 (the default) means unlimited, so an untouched deployment behaves
    // exactly as it did before this existed.
    //
    // Counted against the MONTH BEING CORRECTED, not the month the request was
    // typed in — otherwise filing late for last month would spend this month's
    // allowance. Rejected requests do not count: HR already said no, and
    // charging the employee for it as well would be a second penalty.
    //
    // An individual can be raised or lowered off this number with
    // EmployeeProfile.regularizationMonthlyLimit. Unlike lateAllowance this is
    // NOT SuperAdmin-only — it costs nobody money, and it is edited from the
    // regularization Approval setup tab by whoever holds
    // regularizationHierarchy.manage.
    regularizationLimit: { type: Number, default: 0, min: 0, max: 31 },

    // The contact strip printed along the bottom of the documents an employee
    // may forward outside the company — today the cashbook statement
    // (services/cashbookSummaryPdf.js).
    //
    // SuperAdmin-only, and deliberately NOT in config/company.js: that file is
    // env-var constants, so changing the number a client is told to ring would
    // need a redeploy. A blank helpline prints no help line at all rather than
    // falling back to the office switchboard, because "no number" is a
    // legitimate choice for a document that leaves the building.
    documentFooter: {
      helpline: { type: String, trim: true, maxlength: 40, default: '' },
      // One line of small print under the company name — "Queries within 7 days
      // of receipt", a GSTIN, whatever the finance team wants on it.
      note: { type: String, trim: true, maxlength: 120, default: '' },
    },

    // Incentives (Admin → Incentive). Defaults only: every entry copies both
    // figures onto itself and then freezes them (IncentiveEntry.rupeePerPoint /
    // pointsPerSheet), so changing either here never restates a day already
    // recorded.
    incentive: {
      // WHAT ONE POINT IS WORTH. Company-wide on purpose — every incentive pays
      // in points and this is the single place their rupee value is set, so a
      // re-valuation moves all of them together (Admin → Incentive → Point
      // Rate). Edited by whoever holds `incentive.manage`.
      rupeePerPoint: { type: Number, default: 1, min: 0 },
      // What one rolled sheet is worth, in points, in the BOYS incentive. Lives
      // beside the universal figure rather than in that module because it is a
      // default a person has to be able to change; another incentive will bring
      // its own per-unit yield.
      pointsPerSheet: { type: Number, default: 4, min: 0 },
      // NOTE: there is deliberately no department setting. The Boys module is
      // the BOYS department's incentive and only theirs — another department
      // gets its own tab rather than a dropdown here (user decision
      // 2026-09-10). The controller resolves the department name itself.

      // WHO MAY SEE WHOSE POINTS on the employee-facing leaderboard
      // (My Incentive ▸ Leaderboard). SuperAdmin-only, and deliberately here
      // rather than behind `incentive.manage`: it decides what one department
      // learns about another's earnings, which is a company decision, not a
      // supervisor's (user decision 2026-09-11).
      //
      // A person's OWN points are never governed by this — they always see
      // their own row, on the first tab, whatever is set here. This is only
      // about the comparison.
      leaderboard: {
        // Off hides the tab for everyone. The date-wise tab stays.
        enabled: { type: Boolean, default: true },
        // What a department with NO rule below sees. 'own' is the safe default
        // — opening the whole company's earnings to everybody has to be a
        // choice somebody made, not what happens when nobody configured it.
        defaultScope: { type: String, enum: ['own', 'all', 'none'], default: 'own' },
        // The rules. One row per VIEWING department, naming the departments it
        // may see: { department: 'IT', canView: ['IT', 'HR'] }. A viewer's own
        // department is always readable to them — the controller adds it — so a
        // rule only ever has to list the OTHERS.
        visibility: {
          type: [
            new mongoose.Schema(
              {
                department: { type: String, trim: true, required: true },
                canView: { type: [String], default: [] },
              },
              { _id: false }
            ),
          ],
          default: [],
        },
      },
    },

    // Letterhead branding, uploaded by a SuperAdmin from Admin → Email & Letter
    // Templates and applied to every generated document (offer, appointment,
    // payslip). Images are GridFS keys, same as User.photo — see services/storage.js.
    //
    // Why here and not config/company.js: that file is env-var constants, so
    // changing a signature would need a redeploy. This is the org-settings
    // singleton, which is exactly the runtime-editable equivalent.
    branding: {
      // Company logo drawn at the top-left of every letterhead. Falls back to
      // ORG_LOGO_PATH, then the bundled backend/assets/logo.png.
      logoPath: { type: String, default: '' },
      // Named signature slots. Keyed rather than free-form so a renderer can ask
      // for "the CEO's signature" without guessing at array order, and so
      // re-uploading one replaces it in place.
      signatures: {
        type: [
          new mongoose.Schema(
            {
              key: { type: String, enum: SIGNATURE_KEYS, required: true },
              storagePath: { type: String, required: true },
              // Printed under the signature image. Blank falls back to the
              // COMPANY defaults so an unnamed slot still renders sensibly.
              signatoryName: { type: String, trim: true, default: '' },
              signatoryTitle: { type: String, trim: true, default: '' },
              updatedAt: { type: Date, default: Date.now },
            },
            { _id: false }
          ),
        ],
        default: [],
      },
    },
  },
  { timestamps: true }
);

// Return the singleton, creating it with defaults on first access.
settingSchema.statics.getSettings = async function getSettings() {
  let doc = await this.findOne({ singleton: 'global' });
  if (!doc) doc = await this.create({ singleton: 'global' });
  return doc;
};

module.exports = mongoose.model('Setting', settingSchema);
module.exports.SIGNATURE_KEYS = SIGNATURE_KEYS;
module.exports.SIGNATURE_LABELS = SIGNATURE_LABELS;
