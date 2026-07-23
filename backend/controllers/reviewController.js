/**
 * Review controller — 360/performance review cycles and their individual reviews.
 * HR manage ReviewCycles (competencies) and assign Reviews (employee+reviewer);
 * reviewers fill in and submit ratings; employees read anonymized feedback
 * written about them.
 */
const asyncHandler = require('express-async-handler');
const ReviewCycle = require('../models/Review');
const { Review } = require('../models/Review');

// ===== Employee self-service =====

/**
 * List reviews assigned to the caller as reviewer.
 * @route GET /api/reviews/me/assigned
 * @returns {{count: number, reviews: Object[]}} with populated employee/cycle
 */
// GET /api/reviews/me/assigned
const myReviews = asyncHandler(async (req, res) => {
  const reviews = await Review.find({ reviewer: req.user._id })
    .populate('employee', 'firstName lastName')
    .populate('cycle', 'name competencies status')
    .sort({ createdAt: -1 });
  res.json({ count: reviews.length, reviews });
});

/**
 * List submitted reviews written about the caller, with reviewer identity omitted.
 * @route GET /api/reviews/me/about
 * @returns {{count: number, reviews: Object[]}} anonymized (no reviewer field)
 */
// GET /api/reviews/me/about
// Submitted reviews about the current user. Reviewer identity is hidden to
// preserve the confidentiality of peer/360 feedback.
const aboutMe = asyncHandler(async (req, res) => {
  const docs = await Review.find({ employee: req.user._id, status: 'Submitted' })
    .populate('cycle', 'name competencies status')
    .sort({ createdAt: -1 });

  const reviews = docs.map((r) => ({
    _id: r._id,
    cycle: r.cycle,
    relationship: r.relationship,
    ratings: r.ratings,
    overallRating: r.overallRating,
    strengths: r.strengths,
    improvements: r.improvements,
    status: r.status,
    submittedAt: r.submittedAt,
  }));

  res.json({ count: reviews.length, reviews });
});

/**
 * Reviewer fills in ratings/feedback and submits their assigned review.
 * @route PATCH /api/reviews/me/:id
 * @param {string} req.params.id - review id
 * @param {Array} [req.body.ratings]
 * @param {number} [req.body.overallRating]
 * @param {string} [req.body.strengths]
 * @param {string} [req.body.improvements]
 * @returns {{review: Object}} with status 'Submitted'
 */
// PATCH /api/reviews/me/:id
const submitReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.params.id);
  if (!review) {
    res.status(404);
    throw new Error('Review not found');
  }
  // Permission gate: only the assigned reviewer may submit
  if (String(review.reviewer) !== String(req.user._id)) {
    res.status(403);
    throw new Error('You are not the assigned reviewer for this review');
  }

  const { ratings, overallRating, strengths, improvements } = req.body;
  if (ratings !== undefined) review.ratings = ratings;
  if (overallRating !== undefined) review.overallRating = overallRating;
  if (strengths !== undefined) review.strengths = strengths;
  if (improvements !== undefined) review.improvements = improvements;
  review.status = 'Submitted';
  review.submittedAt = new Date();
  await review.save();

  res.json({ review });
});

// ===== HR/Admin =====

/**
 * List all review cycles, each with a count of its reviews.
 * @route GET /api/reviews/cycles
 * @returns {{count: number, cycles: Object[]}} each with reviewCount
 */
// GET /api/reviews/cycles
const listCycles = asyncHandler(async (req, res) => {
  const cycles = await ReviewCycle.find().sort({ createdAt: -1 }).lean();
  const withCounts = await Promise.all(
    cycles.map(async (c) => ({
      ...c,
      reviewCount: await Review.countDocuments({ cycle: c._id }),
    }))
  );
  res.json({ count: withCounts.length, cycles: withCounts });
});

/**
 * Create a review cycle.
 * @route POST /api/reviews/cycles
 * @param {string} req.body.name - required
 * @param {Object} req.body - other cycle fields (competencies, status, dates)
 * @returns {{cycle: Object}} (201)
 */
// POST /api/reviews/cycles
const createCycle = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }
  const cycle = await ReviewCycle.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ cycle });
});

/**
 * Update a review cycle (partial).
 * @route PUT /api/reviews/cycles/:id
 * @param {string} req.params.id - cycle id
 * @param {Object} req.body - fields to update
 * @returns {{cycle: Object}}
 */
// PUT /api/reviews/cycles/:id
const updateCycle = asyncHandler(async (req, res) => {
  const cycle = await ReviewCycle.findById(req.params.id);
  if (!cycle) {
    res.status(404);
    throw new Error('Cycle not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(cycle, req.body);
  await cycle.save();
  res.json({ cycle });
});

/**
 * Delete a review cycle and all reviews under it.
 * @route DELETE /api/reviews/cycles/:id
 * @param {string} req.params.id - cycle id
 * @returns {{id: string, deleted: boolean}}
 */
// DELETE /api/reviews/cycles/:id
const deleteCycle = asyncHandler(async (req, res) => {
  const cycle = await ReviewCycle.findById(req.params.id);
  if (!cycle) {
    res.status(404);
    throw new Error('Cycle not found');
  }
  // Cascade: remove the cycle's child reviews before the cycle itself
  await Review.deleteMany({ cycle: cycle._id });
  await cycle.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Assign a reviewer to evaluate an employee within a cycle; seeds empty ratings
 * from the cycle's competencies.
 * @route POST /api/reviews/cycles/:id/assign
 * @param {string} req.params.id - cycle id
 * @param {string} req.body.employee - employee being reviewed (required)
 * @param {string} req.body.reviewer - reviewer (required)
 * @param {string} [req.body.relationship='peer']
 * @returns {{review: Object}} (201)
 */
// POST /api/reviews/cycles/:id/assign
const assignReview = asyncHandler(async (req, res) => {
  const cycle = await ReviewCycle.findById(req.params.id);
  if (!cycle) {
    res.status(404);
    throw new Error('Cycle not found');
  }
  const { employee, reviewer, relationship } = req.body;
  if (!employee || !reviewer) {
    res.status(400);
    throw new Error('employee and reviewer are required');
  }

  const ratings = (cycle.competencies || []).map((competency) => ({
    competency,
    score: 0,
    comment: '',
  }));

  const review = await Review.create({
    cycle: cycle._id,
    employee,
    reviewer,
    relationship: relationship || 'peer',
    ratings,
  });

  res.status(201).json({ review });
});

/**
 * List all reviews under a cycle (admin view, reviewers visible).
 * @route GET /api/reviews/cycles/:id/reviews
 * @param {string} req.params.id - cycle id
 * @returns {{count: number, reviews: Object[]}} with populated employee/reviewer
 */
// GET /api/reviews/cycles/:id/reviews
const cycleReviews = asyncHandler(async (req, res) => {
  const reviews = await Review.find({ cycle: req.params.id })
    .populate('employee', 'firstName lastName')
    .populate('reviewer', 'firstName lastName')
    .sort({ createdAt: -1 });
  res.json({ count: reviews.length, reviews });
});

module.exports = {
  myReviews,
  aboutMe,
  submitReview,
  listCycles,
  createCycle,
  updateCycle,
  deleteCycle,
  assignReview,
  cycleReviews,
};
