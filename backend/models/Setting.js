const mongoose = require('mongoose');
const OFFICE = require('../config/office');

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
