const mongoose = require('mongoose');

const CANDIDATE_STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Onboarding', 'Hired', 'Rejected'];
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

    // Uploaded resume (storage-relative path; served through an auth route).
    resumePath: { type: String },
    resumeName: { type: String },
    resumeSizeBytes: { type: Number },

    // Four interview rounds whose status HR can change.
    rounds: { type: [roundSchema], default: defaultRounds },

    // Generated offer letter + the boilerplate fields HR filled in.
    offer: {
      generatedAt: { type: Date },
      generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      generatedByName: { type: String, trim: true },
      letterPath: { type: String },
      letterName: { type: String },
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

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Never leak the filesystem path; expose only whether a resume exists.
candidateSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.hasResume = !!ret.resumePath;
    delete ret.resumePath;
    // Expose only whether a letter exists, never the filesystem path.
    if (ret.offer) { ret.offer.hasLetter = !!ret.offer.letterPath; delete ret.offer.letterPath; }
    if (ret.appointment) { ret.appointment.hasLetter = !!ret.appointment.letterPath; delete ret.appointment.letterPath; }
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Candidate', candidateSchema);
module.exports.CANDIDATE_STAGES = CANDIDATE_STAGES;
module.exports.ROUND_STATUS = ROUND_STATUS;
module.exports.defaultRounds = defaultRounds;
