/**
 * Rewards & Recognition controller — monthly R&R awards (RnrAward) with an
 * Employee-of-the-Month and Key Achievers. HR draft (secret) then announce an
 * award, which notifies everyone and shows a banner for 2 working days; employees
 * see and dismiss the current banner.
 */
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

/**
 * Get the live R&R banner for the caller (announced, not expired, not dismissed).
 * @route GET /api/rnr/current
 * @returns {{award: Object|null}} winners + period, or null when nothing to show
 */
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

/**
 * Dismiss the R&R banner for the caller (adds them to dismissedBy).
 * @route POST /api/rnr/:id/dismiss
 * @param {string} req.params.id - award id
 * @returns {{dismissed: boolean}}
 */
// POST /api/rnr/:id/dismiss — hide the banner for this user.
const dismissBanner = asyncHandler(async (req, res) => {
  await RnrAward.updateOne({ _id: req.params.id }, { $addToSet: { dismissedBy: req.user._id } });
  res.json({ dismissed: true });
});

// ===== HR / Admin =====

/**
 * Get a single month's award, or the recent award history (last 24).
 * @route GET /api/rnr?year=&month=  (HR/Admin)
 * @param {number} [req.query.year]
 * @param {number} [req.query.month]
 * @returns {{award: Object}} when year+month given, else {{awards: Object[]}}
 */
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

/**
 * List active employees plus the department set, for the winner pickers.
 * @route GET /api/rnr/people  (HR/Admin)
 * @returns {{people: Object[], departments: string[]}}
 */
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

/**
 * Create or update the (secret) Draft award for a month; cannot edit once announced.
 * @route POST /api/rnr  (HR/Admin)
 * @param {number} req.body.year - required
 * @param {number} req.body.month - required 1-12
 * @param {Array} req.body.winners - [{category, department, user, citation}]; enriched with a name/photo snapshot
 * @returns {{award: Object}} (201)
 */
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

/**
 * Publish a draft award: mark Announced, set the 2-working-day banner expiry, and
 * notify all active users.
 * @route POST /api/rnr/:id/announce  (HR/Admin)
 * @param {string} req.params.id - award id
 * @returns {{award: Object}}; 400 if already announced or has no winners
 * @sideeffect notifies every active user of the winners
 */
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

/**
 * Delete a Draft award (announced awards are retained as a permanent record).
 * @route DELETE /api/rnr/:id  (HR/Admin)
 * @param {string} req.params.id - award id
 * @returns {{id: string, deleted: boolean}}; 400 if already announced
 */
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
