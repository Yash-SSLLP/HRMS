const mongoose = require('mongoose');

// A recruitment candidate and their full journey through the hiring pipeline:
// interview rounds, pre-offer document collection, generated offer/appointment
// letters, onboarding, and finally conversion into a User + EmployeeProfile.
// `stage` is the ordered pipeline position; Hired/Rejected are terminal.
const CANDIDATE_STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Onboarding', 'NewJoinee', 'Hired', 'Rejected'];
// Per interview-round outcome: Pending -> not yet set; Scheduled -> slot booked; Cleared -> passed; Rejected -> failed.
const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
const NUM_ROUNDS = 4;

// One entry per status change of a round — the audit trail of who decided what.
const roundHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ROUND_STATUS },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true },
    at: { type: Date, default: Date.now },
    feedback: { type: String, trim: true },
  },
  { _id: false }
);

const roundSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    status: { type: String, enum: ROUND_STATUS, default: 'Pending' },
    feedback: { type: String, trim: true },
    scheduledAt: { type: Date },
    decidedAt: { type: Date },
    // Employee (User) HR assigned to take this interview round.
    interviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    interviewerName: { type: String, trim: true },
    // Video-call link for this round (e.g. Google Meet).
    meetingLink: { type: String, trim: true },
    // Google Calendar event id backing an auto-created Meet link, if any.
    meetEventId: { type: String, trim: true },
    // Planned duration of the interview slot (used in the invite email).
    meetDurationMinutes: { type: Number },
    // Who last changed this round's status (+ full change history).
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    history: { type: [roundHistorySchema], default: [] },
  },
  { _id: true }
);

// Four interview rounds, all Pending by default.
function defaultRounds() {
  return Array.from({ length: NUM_ROUNDS }, (_, i) => ({ label: `Round ${i + 1}`, status: 'Pending' }));
}

// One uploaded document in a candidate's pre-offer submission.
const candidateDocSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    name: { type: String },
    storagePath: { type: String },
    // Durable Cloudinary backup of the same file (fallback if the disk copy is lost).
    cloud: {
      publicId: String,
      version: Number,
      format: String,
      resourceType: String,
    },
    sizeBytes: { type: Number },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const candidateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', index: true },
    stage: { type: String, enum: CANDIDATE_STAGES, default: 'Applied' },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    notes: { type: String, trim: true },

    // How the candidate entered the pipeline.
    source: { type: String, enum: ['Portal', 'Application'], default: 'Portal' },

    // Extra details collected by the public application form.
    currentCompany: { type: String, trim: true },
    experienceYears: { type: Number, min: 0 },
    noticePeriod: { type: String, trim: true },
    expectedCtc: { type: String, trim: true },
    coverNote: { type: String, trim: true },

    // Uploaded resume. The bytes live in the DB (resumeData) so they survive
    // redeploys — the filesystem is ephemeral. select:false keeps list queries
    // light; downloadResume selects it explicitly. resumePath is kept only for
    // legacy resumes that were written to disk before DB storage.
    resumePath: { type: String },
    resumeName: { type: String },
    resumeSizeBytes: { type: Number },
    resumeData: { type: Buffer, select: false },
    resumeContentType: { type: String },

    // Four interview rounds whose status HR can change.
    rounds: { type: [roundSchema], default: defaultRounds },

    // Pre-offer document collection: a tokenised link the candidate uploads to,
    // then HR confirms before an offer letter can be created.
    documents: {
      token: { type: String, index: true },
      requestedAt: { type: Date },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      requestedByName: { type: String, trim: true },
      submittedAt: { type: Date },
      confirmedAt: { type: Date },
      confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      confirmedByName: { type: String, trim: true },
      files: { type: [candidateDocSchema], default: [] },
    },

    // Generated offer letter + the boilerplate fields HR filled in.
    offer: {
      generatedAt: { type: Date },
      generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      generatedByName: { type: String, trim: true },
      letterPath: { type: String },
      letterName: { type: String },
      token: { type: String, index: true },
      emailedAt: { type: Date },
      data: {
        position: String,
        department: String,
        address: String,
        refInterviewDate: Date,
        salaryMonthly: Number,
        salaryAnnual: Number,
        probationMonths: Number,
        noticePeriodDays: Number,
        joiningDate: Date,
        acceptanceDeadline: Date,
        signatoryName: String,
        signatoryTitle: String,
      },
    },

    // Generated appointment letter + its CTC-breakup fields.
    appointment: {
      generatedAt: { type: Date },
      generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      generatedByName: { type: String, trim: true },
      letterPath: { type: String },
      letterName: { type: String },
      token: { type: String, index: true },
      emailedAt: { type: Date },
      data: {
        designation: String,
        department: String,
        reportingManager: String,
        location: String,
        workingHours: String,
        joiningDate: Date,
        probationMonths: Number,
        noticePeriodDays: Number,
        ctcAnnual: Number,
        basic: Number,
        hra: Number,
        specialAllowance: Number,
        conveyance: Number,
        employerPf: Number,
        gratuity: Number,
        otherAllowances: Number,
      },
    },

    // Pre-joining onboarding details HR manages after an offer is made.
    onboarding: {
      joiningDate: { type: Date },
      noticePeriod: { type: String, trim: true },
      startedAt: { type: Date },
      startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      startedByName: { type: String, trim: true },
      notes: { type: String, trim: true },
    },

    // Set once a New Joinee is converted into an actual User + EmployeeProfile.
    employee: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      profile: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile' },
      employeeCode: { type: String, trim: true },
      convertedAt: { type: Date },
      convertedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      convertedByName: { type: String, trim: true },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Never leak the filesystem path; expose only whether a resume exists.
candidateSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.hasResume = !!(ret.resumePath || ret.resumeName);
    delete ret.resumePath;
    delete ret.resumeData;
    // Expose only whether a letter exists, never the filesystem path.
    if (ret.offer) { ret.offer.hasLetter = !!ret.offer.letterPath; delete ret.offer.letterPath; }
    if (ret.appointment) { ret.appointment.hasLetter = !!ret.appointment.letterPath; delete ret.appointment.letterPath; }
    // Never leak document filesystem paths; keep id/label/name/size for HR review.
    if (ret.documents && Array.isArray(ret.documents.files)) {
      ret.documents.files.forEach((f) => { delete f.storagePath; delete f.cloud; });
    }
    delete ret.__v;
    return ret;
  },
});

// Audit-status plugin: logs `stage` transitions to AuditLog (labelled by candidate name).
candidateSchema.plugin(require('./plugins/auditStatus'), { fields: ['stage'], label: (d) => d.name });

module.exports = mongoose.model('Candidate', candidateSchema);
module.exports.CANDIDATE_STAGES = CANDIDATE_STAGES;
module.exports.ROUND_STATUS = ROUND_STATUS;
module.exports.defaultRounds = defaultRounds;
