const asyncHandler = require('express-async-handler');
const ReviewCycle = require('../models/Review');
const { Review } = require('../models/Review');

// ===== Employee self-service =====

// GET /api/reviews/me/assigned
const myReviews = asyncHandler(async (req, res) => {
  const reviews = await Review.find({ reviewer: req.user._id })
    .populate('employee', 'firstName lastName')
    .populate('cycle', 'name competencies status')
    .sort({ createdAt: -1 });
  res.json({ count: reviews.length, reviews });
});

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

// PATCH /api/reviews/me/:id
const submitReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.params.id);
  if (!review) {
    res.status(404);
    throw new Error('Review not found');
  }
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

// PUT /api/reviews/cycles/:id
const updateCycle = asyncHandler(async (req, res) => {
  const cycle = await ReviewCycle.findById(req.params.id);
  if (!cycle) {
    res.status(404);
    throw new Error('Cycle not found');
  }
  delete req.body.createdBy;
  Object.assign(cycle, req.body);
  await cycle.save();
  res.json({ cycle });
});

// DELETE /api/reviews/cycles/:id
const deleteCycle = asyncHandler(async (req, res) => {
  const cycle = await ReviewCycle.findById(req.params.id);
  if (!cycle) {
    res.status(404);
    throw new Error('Cycle not found');
  }
  await Review.deleteMany({ cycle: cycle._id });
  await cycle.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

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
