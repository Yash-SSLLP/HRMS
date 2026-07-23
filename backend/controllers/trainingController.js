/**
 * Training controller — CRUD for Training sessions/programs (title, dates,
 * participants, status). Backs the HR training-management screens.
 */
const asyncHandler = require('express-async-handler');
const Training = require('../models/Training');
const { TRAINING_STATUS } = require('../models/Training');

const USER_FIELDS = 'firstName lastName email role';

/**
 * List trainings, optionally filtered by status, most recent start first.
 * @route GET /api/trainings
 * @param {string} [req.query.status]
 * @returns {{count: number, trainings: Object[]}} with populated participants
 */
const listTrainings = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const trainings = await Training.find(filter)
    .populate('participants', USER_FIELDS)
    .sort({ startDate: -1, createdAt: -1 });
  res.json({ count: trainings.length, trainings });
});

/**
 * Create a training.
 * @route POST /api/trainings
 * @param {string} req.body.title - required
 * @param {string} [req.body.status] - must be one of TRAINING_STATUS
 * @returns {{training: Object}} (201)
 */
const createTraining = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  if (req.body.status && !TRAINING_STATUS.includes(req.body.status)) {
    res.status(400);
    throw new Error(`status must be one of ${TRAINING_STATUS.join(', ')}`);
  }
  const training = await Training.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ training });
});

/**
 * Update a training (partial).
 * @route PUT /api/trainings/:id
 * @param {string} req.params.id - training id
 * @param {Object} req.body - fields to update
 * @returns {{training: Object}}
 */
const updateTraining = asyncHandler(async (req, res) => {
  const training = await Training.findById(req.params.id);
  if (!training) {
    res.status(404);
    throw new Error('Training not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(training, req.body);
  await training.save();
  res.json({ training });
});

/**
 * Delete a training by id.
 * @route DELETE /api/trainings/:id
 * @param {string} req.params.id - training id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteTraining = asyncHandler(async (req, res) => {
  const training = await Training.findById(req.params.id);
  if (!training) {
    res.status(404);
    throw new Error('Training not found');
  }
  await training.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listTrainings, createTraining, updateTraining, deleteTraining };
