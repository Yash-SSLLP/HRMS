const mongoose = require('mongoose');

const CANDIDATE_STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
const NUM_ROUNDS = 4;

const roundSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true },
    status: { type: String, enum: ROUND_STATUS, default: 'Pending' },
    feedback: { type: String, trim: true },
    scheduledAt: { type: Date },
    decidedAt: { type: Date },
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

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Never leak the filesystem path; expose only whether a resume exists.
candidateSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.hasResume = !!ret.resumePath;
    delete ret.resumePath;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Candidate', candidateSchema);
module.exports.CANDIDATE_STAGES = CANDIDATE_STAGES;
module.exports.ROUND_STATUS = ROUND_STATUS;
module.exports.defaultRounds = defaultRounds;
