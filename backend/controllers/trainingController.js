/**
 * Training controller — CRUD for Training sessions/programs (title, dates,
 * participants, status). Backs the HR training-management screens.
 */
const asyncHandler = require('express-async-handler');
const Training = require('../models/Training');
const User = require('../models/User');
const { TRAINING_STATUS } = require('../models/Training');
// Company wall: Training.participants refs User, so the User-keyed helper applies.
const { allowedUserIds } = require('../utils/employeeScope');
const { pickableUserFilter } = require('../utils/peoplePicker');
// IST day boundaries — the company's calendar day, and what a bare date means.
const { istDayRange } = require('../utils/istDate');

const USER_FIELDS = 'firstName lastName email role';

/**
 * A training's start/end as an absolute instant.
 *
 * THE POINT OF THIS is that 'YYYY-MM-DD' and '…T09:30' do not mean the same
 * kind of thing, and only one of them is ambiguous. `new Date('2026-09-23')`
 * is UTC midnight — 05:30 IST — so a bare date stored as-is is indistinguishable
 * from a training that really does start at half past five in the morning. The
 * clients cannot tell them apart afterwards, so they must not have to: a bare
 * date is pinned to IST midnight here, at the only place that sees the raw
 * request, and every "no time was set" value in the collection then has one
 * shape.
 *
 * Bare dates are not legacy. The Android build in people's pockets sends them,
 * and will keep sending them until everybody updates.
 *
 * Anything carrying a time is already an instant and is left alone.
 * @param {*} v
 * @returns {Date|null|undefined} undefined when the caller did not mention the field
 */
const asInstant = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return istDayRange(v)[0];
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Normalise both dates on an incoming body and refuse a backwards range.
 *
 * Checked on the SERVER because it is the only place both clients pass through:
 * the web form prevents it with the End input's `min`, the phone's two pickers
 * cannot (the date picker's minimumDate says nothing about the time of day), and
 * an API caller is bound by neither.
 * @param {object} body - mutated in place
 * @param {object} res
 * @param {object} [existing] - the stored training, on an update
 */
const normaliseDates = (body, res, existing = {}) => {
  const start = asInstant(body.startDate);
  const end = asInstant(body.endDate);
  if (start !== undefined) body.startDate = start;
  if (end !== undefined) body.endDate = end;
  // Compare what the document will HOLD, not only what was sent: moving just
  // the start of an existing training can invert it against an end nobody
  // touched.
  const s = start !== undefined ? start : existing.startDate;
  const e = end !== undefined ? end : existing.endDate;
  if (s && e && new Date(e) < new Date(s)) {
    res.status(400);
    throw new Error('A training cannot end before it starts.');
  }
};

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
    .sort({ startDate: -1, createdAt: -1 })
    .lean();
  // Company wall: trainings themselves are shared config (titles/dates stay
  // visible), but the attendee list is people-data — a walled viewer only sees
  // participants from their own company.
  const ids = await allowedUserIds(req);
  const visible = ids
    ? trainings.map((t) => ({
        ...t,
        participants: (t.participants || []).filter((p) => p && ids.includes(String(p._id))),
      }))
    : trainings;
  res.json({ count: visible.length, trainings: visible });
});

/**
 * The people who can be put on a training.
 *
 * ITS OWN ROUTE, not GET /admin/users — that one is restrictTo(SuperAdmin,
 * HRManager, CEO, MD, LDManager), so the moment `training.manage` became
 * grantable to anybody (User.trainingAccess) the picker would have 403'd for
 * exactly the people the grant was created for: an Employee running training
 * could open the form and find nobody to add to it. Assets and Incentive own
 * their pickers for the same reason.
 *
 * `pickableUserFilter` carries the rules that are easy to forget — active
 * accounts only, no SuperAdmin or audit login, executives only if a SuperAdmin
 * opted them in — and the company wall.
 * @route GET /api/trainings/people   (training.manage)
 * @returns {{count: number, users: Object[]}}
 */
const listTrainingPeople = asyncHandler(async (req, res) => {
  const users = await User.find(await pickableUserFilter(req))
    .select(USER_FIELDS)
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  res.json({ count: users.length, users });
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
  normaliseDates(req.body, res);
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
  // Same coercion and the same backwards-range refusal as on create — and it
  // needs the STORED training, because moving only the start can invert it
  // against an end this request never mentioned.
  normaliseDates(req.body, res, training);
  // Company wall, write side: the list handed a walled admin only their own
  // company's participants, so a round-tripped edit must not wipe the ones
  // they could not see. Their submission replaces only the in-wall subset;
  // out-of-wall participants are carried over untouched.
  if (req.body.participants !== undefined) {
    const ids = await allowedUserIds(req);
    if (ids) {
      const keep = (training.participants || []).filter((p) => !ids.includes(String(p)));
      const submitted = (req.body.participants || []).filter((p) => ids.includes(String(p)));
      req.body.participants = [...keep, ...submitted];
    }
  }
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

module.exports = {
  listTrainingPeople, listTrainings, createTraining, updateTraining, deleteTraining };
