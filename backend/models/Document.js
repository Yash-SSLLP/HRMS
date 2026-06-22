const mongoose = require('mongoose');

// Categories an employee may upload themselves
const SELF_UPLOAD_CATEGORIES = [
  'PAN',
  'Aadhaar',
  'PassportPhoto',
  'AddressProof',
  'EducationCertificate',
  'ExperienceLetter',
  'Other',
];

// Additional categories HR may attach on behalf of the employee
const HR_ONLY_CATEGORIES = [
  'OfferLetter',
  'AppointmentLetter',
  'AppraisalLetter',
  'RelievingLetter',
  'NDA',
  'Contract',
];

const ALL_CATEGORIES = [...SELF_UPLOAD_CATEGORIES, ...HR_ONLY_CATEGORIES];

// PII categories trigger restricted access (HR-only download for non-owners)
const PII_CATEGORIES = ['PAN', 'Aadhaar', 'AddressProof'];

// Categories an employee is expected to submit. Used to flag whether an
// employee's document set is "complete" (the catch-all 'Other' is not required).
const REQUIRED_DOCUMENT_CATEGORIES = [
  'PAN',
  'Aadhaar',
  'PassportPhoto',
  'AddressProof',
  'EducationCertificate',
  'ExperienceLetter',
];

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
    mime: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true, length: 64 },
    isPii: { type: Boolean, default: false },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, maxlength: 500 },

    // HR verification workflow: an employee-submitted doc starts 'Submitted';
    // HR reviews and marks it 'Verified' (or 'Rejected' with a note).
    status: { type: String, enum: ['Submitted', 'Verified', 'Rejected'], default: 'Submitted', index: true },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    reviewNote: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

documentSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.storagePath; // never leak filesystem path to API consumers
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Document', documentSchema);
module.exports.SELF_UPLOAD_CATEGORIES = SELF_UPLOAD_CATEGORIES;
module.exports.HR_ONLY_CATEGORIES = HR_ONLY_CATEGORIES;
module.exports.ALL_CATEGORIES = ALL_CATEGORIES;
module.exports.PII_CATEGORIES = PII_CATEGORIES;
module.exports.REQUIRED_DOCUMENT_CATEGORIES = REQUIRED_DOCUMENT_CATEGORIES;
