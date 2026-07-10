const asyncHandler = require('express-async-handler');
const RnrAward = require('../models/RnrAward');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Holiday = require('../models/Holiday');
const { notifyMany } = require('../services/notify');
const { startOfDayIST, ymdIST } = require('../utils/dateHelpers');

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Banner visibility = 2 working days from the announcement. Returns the instant
// (IST midnight) at which the banner should stop showing: the start of the day
// after the 2nd working day of visibility. Sundays and holidays don't count.
async function bannerExpiryFromNow(fromDate) {
  const start = startOfDayIST(fromDate);
  const windowEnd = new Date(start.getTime() + 20 * 86400000);
  const holidays = await Holiday.find({ date: { $gte: start, $lte: windowEnd } })
    .select('date').lean().catch(() => []);
  const holidayKeys = new Set((holidays || []).map((h) => ymdIST(h.date)));
  const isWorking = (day) => {
    const key = ymdIST(day);
    const [Y, M, D] = key.split('-').map(Number);
    return new Date(Date.UTC(Y, M - 1, D)).getUTCDay() !== 0 && !holidayKeys.has(key);
  };
  let day = start;
  let workingSeen = isWorking(day) ? 1 : 0; // the announce day counts if it's a working day
  let guard = 0;
  while (workingSeen < 2 && guard < 60) {
    guard += 1;
    day = startOfDayIST(new Date(day.getTime() + 24 * 60 * 60 * 1000));
    if (isWorking(day)) workingSeen += 1;
  }
  return startOfDayIST(new Date(day.getTime() + 24 * 60 * 60 * 1000));
}

// Snapshot each picked winner with their current name / designation / department
// / photo so the banner is self-contained.
async function enrichWinners(winners) {
  const out = [];
  const seen = new Set();
  for (const w of winners || []) {
    if (!w || !w.user || seen.has(String(w.user))) continue;
    const user = await User.findById(w.user).select('firstName lastName photo isActive');
    if (!user || user.isActive === false) continue;
    seen.add(String(w.user));
    const profile = await EmployeeProfile.findOne({ user: w.user }).select('designation department');
    const category = w.category === 'EmployeeOfMonth' ? 'EmployeeOfMonth' : 'KeyAchiever';
    out.push({
      category,
      department: category === 'KeyAchiever' ? (w.department || profile?.department || '') : (profile?.department || ''),
      user: user._id,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      designation: profile?.designation || '',
      photo: user.photo || null,
      citation: String(w.citation || '').trim().slice(0, 500),
    });
  }
  // At most one Employee of the Month.
  const eomIndex = out.findIndex((w) => w.category === 'EmployeeOfMonth');
  return out.filter((w, i) => w.category !== 'EmployeeOfMonth' || i === eomIndex);
}

// ===== Employee / self-service =====

// GET /api/rnr/current — the live banner for this user (announced, not expired,
// not dismissed). Returns { award: null } when there's nothing to show.
const currentBanner = asyncHandler(async (req, res) => {
  const now = new Date();
  const award = await RnrAward.findOne({
    status: 'Announced',
    bannerExpiresAt: { $gt: now },
    dismissedBy: { $ne: req.user._id },
  }).sort({ announcedAt: -1 });
  if (!award) return res.json({ award: null });
  res.json({
    award: {
      _id: award._id,
      year: award.year,
      month: award.month,
      monthName: MONTHS[award.month],
      announcedAt: award.announcedAt,
      winners: award.winners,
    },
  });
});

// POST /api/rnr/:id/dismiss — hide the banner for this user.
const dismissBanner = asyncHandler(async (req, res) => {
  await RnrAward.updateOne({ _id: req.params.id }, { $addToSet: { dismissedBy: req.user._id } });
  res.json({ dismissed: true });
});

// ===== HR / Admin =====

// GET /api/rnr?year=&month=  — a single month's award, or the recent history.
const listAwards = asyncHandler(async (req, res) => {
  const { year, month } = req.query;
  if (year && month) {
    const award = await RnrAward.findOne({ year: Number(year), month: Number(month) });
    return res.json({ award });
  }
  const awards = await RnrAward.find().sort({ year: -1, month: -1 }).limit(24);
  res.json({ awards });
});

// GET /api/rnr/people — active employees (+ the department list) for the pickers.
const listPeople = asyncHandler(async (req, res) => {
  const profiles = await EmployeeProfile.find()
    .select('designation department user')
    .populate('user', 'firstName lastName photo isActive');
  const people = profiles
    .filter((p) => p.user && p.user.isActive !== false)
    .map((p) => ({
      user: p.user._id,
      name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim(),
      designation: p.designation || '',
      department: p.department || '',
      photo: p.user.photo || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const departments = [...new Set(people.map((x) => x.department).filter(Boolean))].sort();
  res.json({ people, departments });
});

// POST /api/rnr  { year, month, winners:[{category, department, user, citation}] }
// Create or update the (secret) Draft for a month.
const upsertAward = asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) {
    res.status(400);
    throw new Error('A valid year and month are required');
  }
  let award = await RnrAward.findOne({ year, month });
  if (award && award.status === 'Announced') {
    res.status(400);
    throw new Error('This month is already announced and can no longer be edited.');
  }
  const winners = await enrichWinners(req.body.winners);
  if (award) {
    award.winners = winners;
    award.createdBy = req.user._id;
    await award.save();
  } else {
    award = await RnrAward.create({ year, month, winners, createdBy: req.user._id });
  }
  res.status(201).json({ award });
});

// POST /api/rnr/:id/announce — publish the award: notify everyone + start the
// 2-working-day banner.
const announceAward = asyncHandler(async (req, res) => {
  const award = await RnrAward.findById(req.params.id);
  if (!award) {
    res.status(404);
    throw new Error('Award not found');
  }
  if (award.status === 'Announced') {
    res.status(400);
    throw new Error('This award is already announced.');
  }
  if (!award.winners || award.winners.length === 0) {
    res.status(400);
    throw new Error('Add at least one winner before announcing.');
  }
  const now = new Date();
  award.status = 'Announced';
  award.announcedAt = now;
  award.bannerExpiresAt = await bannerExpiryFromNow(now);
  award.dismissedBy = [];
  await award.save();

  const period = `${MONTHS[award.month]} ${award.year}`;
  const eom = award.winners.find((w) => w.category === 'EmployeeOfMonth');
  const users = await User.find({ isActive: true }).select('_id');
  await notifyMany(users.map((u) => u._id), {
    type: 'recognition',
    audience: 'employee',
    title: `🏆 ${period} Rewards & Recognition`,
    body: eom
      ? `Employee of the Month: ${eom.name}. Congratulations to all the winners!`
      : 'Congratulations to all the winners!',
  });

  res.json({ award });
});

// DELETE /api/rnr/:id — remove a Draft (announced awards are kept as a record).
const deleteAward = asyncHandler(async (req, res) => {
  const award = await RnrAward.findById(req.params.id);
  if (!award) {
    res.status(404);
    throw new Error('Award not found');
  }
  if (award.status === 'Announced') {
    res.status(400);
    throw new Error('Announced awards cannot be deleted.');
  }
  await award.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  currentBanner,
  dismissBanner,
  listAwards,
  listPeople,
  upsertAward,
  announceAward,
  deleteAward,
};
