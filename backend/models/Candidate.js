const mongoose = require('mongoose');

const CANDIDATE_STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];

const candidateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', index: true },
    stage: { type: String, enum: CANDIDATE_STAGES, default: 'Applied' },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Candidate', candidateSchema);
module.exports.CANDIDATE_STAGES = CANDIDATE_STAGES;
