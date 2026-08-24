const mongoose = require('mongoose');
const OFFICE = require('../config/office');
const { DEFAULT_LATE_POLICY, MAX_GRACE_MINUTES } = require('../utils/workday');

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
