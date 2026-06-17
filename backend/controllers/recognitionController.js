const asyncHandler = require('express-async-handler');
const Recognition = require('../models/Recognition');
const { RECOGNITION_BADGES } = require('../models/Recognition');
const Notification = require('../models/Notification');
const User = require('../models/User');

const USER_FIELDS = 'firstName lastName role';

// GET /api/recognition  — the public recognition wall
const listRecognitions = asyncHandler(async (req, res) => {
  const recognitions = await Recognition.find()
    .populate('from', USER_FIELDS)
    .populate('to', USER_FIELDS)
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ count: recognitions.length, recognitions });
});

// GET /api/recognition/people  — active users (excluding the caller) for the picker
const listPeople = asyncHandler(async (req, res) => {
  const people = await User.find({ isActive: true, _id: { $ne: req.user._id } })
    .select(USER_FIELDS)
    .sort({ firstName: 1 });
  res.json({ people });
});

// POST /api/recognition  — give kudos to a colleague
const giveRecognition = asyncHandler(async (req, res) => {
  const { to, badge, message } = req.body;

  if (!to || !message) {
    res.status(400);
    throw new Error('to and message are required');
  }

  if (String(to) === String(req.user._id)) {
    res.status(400);
    throw new Error('You cannot recognize yourself');
  }

  const chosenBadge = RECOGNITION_BADGES.includes(badge) ? badge : 'Team Player';

  const recognition = await Recognition.create({
    from: req.user._id,
    to,
    badge: chosenBadge,
    message,
  });

  await Notification.create({
    recipient: to,
    type: 'recognition',
    title: `🏆 ${req.user.firstName} ${req.user.lastName} recognized you: ${chosenBadge}`,
    body: message,
  });

  res.status(201).json({ recognition });
});

// GET /api/recognition/me  — recognitions received by the caller
const listMine = asyncHandler(async (req, res) => {
  const recognitions = await Recognition.find({ to: req.user._id })
    .populate('from', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: recognitions.length, recognitions });
});

module.exports = {
  listRecognitions,
  listPeople,
  giveRecognition,
  listMine,
};
