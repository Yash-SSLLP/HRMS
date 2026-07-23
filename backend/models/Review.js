const mongoose = require('mongoose');

// Performance-appraisal module. This file defines two related models:
//  - ReviewCycle: a review round/period (e.g. "H1 2026") with its competency list.
//  - Review: one reviewer's feedback on one employee within a cycle (360-style).
// Note the module.exports default is ReviewCycle, with Review attached as a property.
const CYCLE_STATUS = ['Draft', 'Active', 'Closed']; // Draft -> setup; Active -> open for feedback; Closed -> locked
const REVIEW_RELATIONSHIPS = ['self', 'manager', 'peer']; // who the reviewer is relative to the employee
const REVIEW_STATUS = ['Pending', 'Submitted']; // Pending -> not yet filled; Submitted -> completed
const DEFAULT_COMPETENCIES = ['Communication', 'Ownership', 'Technical', 'Teamwork']; // default rating dimensions

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

// Sub-doc: one competency score (1-5) with an optional comment; embedded in a Review.
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
    cycle: { type: mongoose.Schema.Types.ObjectId, ref: 'ReviewCycle', required: true, index: true }, // parent review round
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // person being reviewed
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // person giving feedback
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
// Audit-status plugin: logs Review `status` transitions to AuditLog.
reviewSchema.plugin(require("./plugins/auditStatus"));
const Review = mongoose.model('Review', reviewSchema);

module.exports = ReviewCycle;
module.exports.Review = Review;
module.exports.CYCLE_STATUS = CYCLE_STATUS;
module.exports.REVIEW_RELATIONSHIPS = REVIEW_RELATIONSHIPS;
module.exports.REVIEW_STATUS = REVIEW_STATUS;
module.exports.DEFAULT_COMPETENCIES = DEFAULT_COMPETENCIES;
