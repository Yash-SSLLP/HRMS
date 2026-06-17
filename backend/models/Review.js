const mongoose = require('mongoose');

const CYCLE_STATUS = ['Draft', 'Active', 'Closed'];
const REVIEW_RELATIONSHIPS = ['self', 'manager', 'peer'];
const REVIEW_STATUS = ['Pending', 'Submitted'];
const DEFAULT_COMPETENCIES = ['Communication', 'Ownership', 'Technical', 'Teamwork'];

const reviewCycleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    status: { type: String, enum: CYCLE_STATUS, default: 'Draft', index: true },
    competencies: { type: [String], default: DEFAULT_COMPETENCIES },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const ratingSchema = new mongoose.Schema(
  {
    competency: { type: String },
    score: { type: Number, min: 1, max: 5 },
    comment: { type: String },
  },
  { _id: false }
);

const reviewSchema = new mongoose.Schema(
  {
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewCycle', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    relationship: { type: String, enum: REVIEW_RELATIONSHIPS, default: 'peer' },
    ratings: { type: [ratingSchema], default: [] },
    overallRating: { type: Number },
    strengths: { type: String },
    improvements: { type: String },
    status: { type: String, enum: REVIEW_STATUS, default: 'Pending', index: true },
    submittedAt: { type: Date },
  },
  { timestamps: true }
);

const ReviewCycle = mongoose.model('ReviewCycle', reviewCycleSchema);
const Review = mongoose.model('Review', reviewSchema);

module.exports = ReviewCycle;
module.exports.Review = Review;
module.exports.CYCLE_STATUS = CYCLE_STATUS;
module.exports.REVIEW_RELATIONSHIPS = REVIEW_RELATIONSHIPS;
module.exports.REVIEW_STATUS = REVIEW_STATUS;
module.exports.DEFAULT_COMPETENCIES = DEFAULT_COMPETENCIES;
