const mongoose = require('mongoose');

// An employee document file (ID proof, certificate, HR letter, etc.) attached to
// an EmployeeProfile. Stored on disk with a durable Cloudinary backup, carries an
// HR verification status, and never exposes its storage path via the API.

// Categories an employee may upload themselves. ExperienceLetter covers the
// paperwork from a previous employer, whatever that employer called it.
const SELF_UPLOAD_CATEGORIES = [
  'PAN',
  'Aadhaar',
  'PassportPhoto',
  'EducationCertificate',
  'ExperienceLetter',
  'Other',
];

// Categories nobody is asked for any more, but which EXIST on documents
// already filed. They stay in the schema enum or every save of such a row —
// an HR verification, a status correction — would fail validation on a value
// the employee never chose. They are simply never OFFERED:
//
//   AddressProof    dropped as a requirement; PAN and Aadhaar carry the address.
//   RelievingLetter the same document as ExperienceLetter under another name.
//                   Still arrives through recruitment conversion, which maps a
//                   candidate's own labels (services/candidateDocuments.js).
const RETIRED_CATEGORIES = ['AddressProof', 'RelievingLetter'];

// Additional categories HR may attach on behalf of the employee
const HR_ONLY_CATEGORIES = [
  'OfferLetter',
  'AppointmentLetter',
  'AppraisalLetter',
  'NDA',
  'Contract',
];

const ALL_CATEGORIES = [...SELF_UPLOAD_CATEGORIES, ...HR_ONLY_CATEGORIES, ...RETIRED_CATEGORIES];

// PII categories trigger restricted access (HR-only download for non-owners)
const PII_CATEGORIES = ['PAN', 'Aadhaar', 'AddressProof'];

// What the enum keys are called on screen. Only where the camelCase split
// ("ExperienceLetter" -> "Experience Letter") is not what people call the
// thing; everything else falls through to that split, so this list stays short.
const CATEGORY_LABELS = {
  PassportPhoto: 'Passport Size Photo',
  ExperienceLetter: 'Experience / Relieving Letter',
  PAN: 'PAN',
  NDA: 'NDA',
};

/**
 * The on-screen name of a category.
 * @param {string} c - enum key
 * @returns {string}
 */
function categoryLabel(c) {
  return CATEGORY_LABELS[c] || String(c || '').replace(/([a-z])([A-Z])/g, '$1 $2') || c;
}

// Categories an employee is expected to submit. Used to flag whether an
// employee's document set is "complete".
//
// 'Other' is on the list even though it is a catch-all: most people have
// nothing to put there, and without a row for it there was no way to SAY so —
// the bucket just sat there, neither asked for nor answered. It is satisfied by
// the noOtherDocuments declaration below.
const REQUIRED_DOCUMENT_CATEGORIES = [
  'PAN',
  'Aadhaar',
  'PassportPhoto',
  'EducationCertificate',
  'ExperienceLetter',
  'Other',
];

// Categories a person may legitimately hold SEVERAL of: one letter per past
// employer, one certificate per qualification, and anything at all under the
// catch-all. An upload into one of these ADDS; an upload into any other
// category supersedes the single file already there.
//
// This is not decoration. The public submission link has always accepted
// several files per category, so a vault can hold three "Other" documents —
// and a later upload from the portal would have deleted all three to make room
// for one. Replacing a specific file is done by naming it (`replaces`), not by
// clearing out its category.
const MULTI_UPLOAD_CATEGORIES = ['Other', 'EducationCertificate', 'ExperienceLetter'];

// A requirement the employee can answer instead of meeting, and the flag on
// EmployeeProfile.docDeclarations that answers it. Somebody in their first job
// has no experience letter to give, and most people have no "other" document;
// before this, both sat on the outstanding list for ever and the person had no
// way to say why.
const WAIVABLE_REQUIREMENTS = {
  ExperienceLetter: 'firstJob',
  Other: 'noOtherDocuments',
};

// Categories that COUNT AS another one. A relieving letter is an experience
// letter by a different name, and one still arrives whenever a candidate who
// filed one is converted — it must not leave the requirement looking unmet.
const EQUIVALENT_CATEGORIES = {
  ExperienceLetter: ['ExperienceLetter', 'RelievingLetter'],
};

/**
 * Which required documents are still outstanding.
 *
 * The ONE rule, used by the employee page, the app, the HR document status
 * list, the admin dashboard count and the "please upload" mail. They each used
 * to filter REQUIRED_DOCUMENT_CATEGORIES themselves, which is how a waiver or
 * an equivalent category would have been honoured in one place and not in the
 * four others.
 *
 * @param {Iterable<string>} onFile - categories the employee has filed
 * @param {{firstJob?: boolean, noOtherDocuments?: boolean}} [declarations]
 * @returns {string[]} outstanding categories, in REQUIRED order
 */
function missingRequiredDocuments(onFile, declarations = {}) {
  const have = onFile instanceof Set ? onFile : new Set(onFile || []);
  return REQUIRED_DOCUMENT_CATEGORIES.filter((c) => {
    const accepts = EQUIVALENT_CATEGORIES[c] || [c];
    if (accepts.some((a) => have.has(a))) return false;
    const waiver = WAIVABLE_REQUIREMENTS[c];
    return !(waiver && declarations && declarations[waiver]);
  });
}

const documentSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ALL_CATEGORIES,
      required: true,
    },
    fileName: { type: String, required: true, trim: true },
    storagePath: { type: String, required: true }, // relative to UPLOAD_DIR
    // Durable Cloudinary backup of the same file. If the local disk copy is ever
    // lost, download falls back to this. Enough to rebuild a signed URL.
    cloud: {
      publicId: String,
      version: Number,
      format: String,
      resourceType: String,
    },
    mime: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true, length: 64 },
    isPii: { type: Boolean, default: false },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, maxlength: 500 },

    // Which part of the portal PRODUCED this file, when the portal produced it
    // at all. Absent on everything a person uploaded, which is most rows.
    //
    // It exists so a re-issue can find the copy it supersedes without touching
    // a file somebody uploaded by hand: an appointment letter scanned in and
    // signed is not the same object as the one this portal generated, and only
    // the latter may be replaced. Keep the values stable — they are matched on.
    generatedBy: {
      type: String,
      // 'candidate-letter' — carried onto the employee at conversion from the
      //   recruitment flow (services/candidateDocuments.js).
      // 'employee-letter'  — issued straight from the employee record
      //   (controllers/employeeLetterController.js).
      enum: ['candidate-letter', 'employee-letter'],
      index: true,
    },

    // HR verification workflow: an employee-submitted doc starts 'Submitted';
    // HR reviews and marks it 'Verified' (or 'Rejected' with a note).
    status: { type: String, enum: ['Submitted', 'Verified', 'Rejected'], default: 'Submitted', index: true },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    reviewNote: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

// toJSON transform: strip internal storage refs before sending to API consumers.
documentSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.storagePath; // never leak filesystem path to API consumers
    delete ret.cloud;       // internal backup ref — not for API consumers
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Document', documentSchema);
module.exports.SELF_UPLOAD_CATEGORIES = SELF_UPLOAD_CATEGORIES;
module.exports.RETIRED_CATEGORIES = RETIRED_CATEGORIES;
module.exports.MULTI_UPLOAD_CATEGORIES = MULTI_UPLOAD_CATEGORIES;
module.exports.CATEGORY_LABELS = CATEGORY_LABELS;
module.exports.categoryLabel = categoryLabel;
module.exports.WAIVABLE_REQUIREMENTS = WAIVABLE_REQUIREMENTS;
module.exports.EQUIVALENT_CATEGORIES = EQUIVALENT_CATEGORIES;
module.exports.missingRequiredDocuments = missingRequiredDocuments;
module.exports.HR_ONLY_CATEGORIES = HR_ONLY_CATEGORIES;
module.exports.ALL_CATEGORIES = ALL_CATEGORIES;
module.exports.PII_CATEGORIES = PII_CATEGORIES;
module.exports.REQUIRED_DOCUMENT_CATEGORIES = REQUIRED_DOCUMENT_CATEGORIES;
