/**
 * Rewards & Recognition controller — monthly R&R awards (RnrAward) with an
 * Employee-of-the-Month and Key Achievers. HR draft (secret) then announce an
 * award, which notifies everyone and shows a banner for 2 working days; employees
 * see and dismiss the current banner.
 */
const asyncHandler = require('express-async-handler');
const RnrAward = require('../models/RnrAward');
const RnrCategory = require('../models/RnrCategory');
const AuditLog = require('../models/AuditLog');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Holiday = require('../models/Holiday');
const { notifyMany } = require('../services/notify');
const { startOfDayIST, ymdIST } = require('../utils/dateHelpers');
// Company wall: winner pickers list EmployeeProfiles; award winners and the
// announcement audience are User-keyed.
const { employeeProfileScope, scopeUserFilter, allowedUserIds } = require('../utils/employeeScope');
const { hasDeparted } = require('../utils/departed');

// Company wall: keep only the winners a walled viewer may see (allowedUserIds
// string set; null = unrestricted). Winner snapshots carry names/photos, so an
// out-of-scope winner would leak another company's people-data.
const visibleWinners = (winners, ids) =>
  ids ? (winners || []).filter((w) => ids.includes(String(w.user))) : (winners || []);

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

// ===== Award categories (2026-10-03) =====
// HR/Admin define the categories. "Best Employee" (key EmployeeOfMonth — the
// original top award) always exists, is first, and cannot be deleted or renamed.
// "Key Achiever" (one per department) is seeded once, on the very first run, and
// is an ordinary category after that — deleting it sticks.
const BUILT_IN = [
  { key: 'EmployeeOfMonth', name: 'Best Employee', perDepartment: false, locked: true, order: 0 },
  { key: 'KeyAchiever', name: 'Key Achiever', perDepartment: true, locked: false, order: 1 },
];
const FALLBACK_NAMES = { EmployeeOfMonth: 'Best Employee', KeyAchiever: 'Key Achiever' };

async function ensureCategories() {
  const count = await RnrCategory.estimatedDocumentCount();
  const wanted = count === 0 ? BUILT_IN : BUILT_IN.filter((c) => c.locked);
  for (const c of wanted) {
    // $setOnInsert + upsert: two first visits at once cannot seed it twice.
    await RnrCategory.updateOne({ key: c.key }, { $setOnInsert: c }, { upsert: true }).catch(() => {});
  }
  return RnrCategory.find().sort({ order: 1, createdAt: 1 }).lean();
}
const mapOf = (cats) => new Map(cats.map((c) => [c.key, c]));

/** Winners as plain objects, each carrying its category's name (snapshot first). */
const withNames = (winners, map) => (winners || []).map((w) => {
  const o = w && typeof w.toObject === 'function' ? w.toObject() : { ...w };
  return { ...o, categoryName: o.categoryName || map.get(o.category)?.name || FALLBACK_NAMES[o.category] || o.category };
});

// Snapshot each picked winner with their current name / designation / department
// / photo — and the category's name — so the banner is self-contained.
// One winner per company-wide category, one per department for a per-department
// category; somebody may win different categories in the same month.
async function enrichWinners(winners, catMap) {
  const out = [];
  const slots = new Set();
  for (const w of winners || []) {
    const cat = w && catMap.get(String(w.category || ''));
    if (!cat || !w.user) continue;
    const user = await User.findById(w.user).select('firstName lastName photo isActive');
    if (!user || user.isActive === false) continue;
    const profile = await EmployeeProfile.findOne({ user: w.user }).select('designation department');
    const department = cat.perDepartment ? (w.department || profile?.department || '') : (profile?.department || '');
    if (cat.perDepartment && !department) continue;
    const slot = cat.perDepartment ? `${cat.key}|${department}` : cat.key;
    if (slots.has(slot)) continue;
    slots.add(slot);
    out.push({
      category: cat.key,
      categoryName: cat.name,
      department,
      user: user._id,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      designation: profile?.designation || '',
      photo: user.photo || null,
      citation: String(w.citation || '').trim().slice(0, 500),
    });
  }
  return out;
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
  // Company wall: only show the winners of the viewer's own company; when none
  // of them are in scope there is nothing to celebrate on this side of the wall.
  const winners = withNames(visibleWinners(award.winners, await allowedUserIds(req)), mapOf(await ensureCategories()));
  if (!winners.length) return res.json({ award: null });
  res.json({
    award: {
      _id: award._id,
      year: award.year,
      month: award.month,
      monthName: MONTHS[award.month],
      announcedAt: award.announcedAt,
      winners,
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
  // Company wall: strip winner snapshots of other companies' people for walled
  // admins (the award record itself is shared, its people-data is not).
  const ids = await allowedUserIds(req);
  const map = mapOf(await ensureCategories());
  if (year && month) {
    const award = await RnrAward.findOne({ year: Number(year), month: Number(month) }).lean();
    if (award) award.winners = withNames(visibleWinners(award.winners, ids), map);
    return res.json({ award });
  }
  const awards = await RnrAward.find().sort({ year: -1, month: -1 }).limit(24).lean();
  res.json({ awards: awards.map((a) => ({ ...a, winners: withNames(visibleWinners(a.winners, ids), map) })) });
});

/**
 * List active employees plus the department set, for the winner pickers.
 * @route GET /api/rnr/people  (HR/Admin)
 * @returns {{people: Object[], departments: string[]}}
 */
// GET /api/rnr/people — active employees (+ the department list) for the pickers.
const listPeople = asyncHandler(async (req, res) => {
  // Company wall: a walled admin picks winners only from their own company.
  const profiles = await EmployeeProfile.find(employeeProfileScope(req))
    .select('designation department user dateOfExit')
    .populate('user', 'firstName lastName photo isActive');
  const people = profiles
    // Nobody who has left (utils/departed) — a deactivated login OR a last
    // working day already past.
    .filter((p) => p.user && !hasDeparted(p.user, p))
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
  const catMap = mapOf(await ensureCategories());
  // Which categories this save speaks for. A client that predates custom
  // categories (an older app build) sends none, so it manages only the two
  // original ones — and the draft's winners in any OTHER category are kept, not
  // wiped by a screen that never showed them.
  const managed = new Set(Array.isArray(req.body.categories) && req.body.categories.length
    ? req.body.categories.map(String)
    : ['EmployeeOfMonth', 'KeyAchiever']);
  let winners = await enrichWinners((req.body.winners || []).filter((w) => managed.has(String(w?.category))), catMap);
  // Company wall, write side: the month's draft is one shared record, and a
  // walled admin was only shown their own company's winners — their save must
  // replace that subset, never wipe the winners they could not see.
  const ids = await allowedUserIds(req);
  const visibleToCaller = (w) => !ids || ids.includes(String(w.user));
  if (ids) winners = winners.filter(visibleToCaller);
  const plain = (w) => (typeof w.toObject === 'function' ? w.toObject() : w);
  const old = award ? (award.winners || []).map(plain) : [];
  const invisible = ids ? old.filter((w) => w.user && !visibleToCaller(w)) : [];
  const kept = old.filter((w) => visibleToCaller(w) && !managed.has(w.category) && catMap.has(w.category));
  winners = [...invisible, ...kept, ...winners];
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
  // Company wall: a walled admin's announcement fans out only to their own
  // company; an unrestricted admin still notifies the whole org.
  const users = await User.find(await scopeUserFilter(req, { isActive: true })).select('_id');
  // 2026-10-05 (the user): CEO/MD and Admin get the R&R celebration too.
  // audience 'all' so it shows in the Admin portal bell as well as My Portal
  // (it was 'employee', which hid it from SuperAdmin/HR-in-admin and CEO/MD);
  // `action: true` so notify.js's CEO/MD action-only gate lets it through.
  await notifyMany(users.map((u) => u._id), {
    type: 'recognition',
    audience: 'all',
    action: true,
    title: `🏆 ${period} Rewards & Recognition`,
    body: eom
      ? `${eom.categoryName || 'Best Employee'}: ${eom.name}. Congratulations to all the winners!`
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

// ===== Award categories — HR / Admin =====

const auditCategory = (req, cat, toStatus) => AuditLog.create({
  entity: 'RnrCategory',
  entityId: cat._id,
  entityLabel: cat.name,
  field: 'status',
  fromStatus: '',
  toStatus,
  by: req.user._id,
  byName: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
  byRole: req.user.role,
}).catch(() => {});

/**
 * The award categories, Best Employee first.
 * @route GET /api/rnr/categories  (HR/Admin)
 * @returns {{categories: Object[]}}
 */
const listCategories = asyncHandler(async (req, res) => {
  res.json({ categories: await ensureCategories() });
});

/**
 * Add an award category.
 * @route POST /api/rnr/categories  (HR/Admin)
 * @param {string} req.body.name - required, unique (case-insensitive), max 60
 * @param {boolean} [req.body.perDepartment] - one winner per department
 * @returns {{category: Object, categories: Object[]}} (201)
 */
const createCategory = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) {
    res.status(400);
    throw new Error('A category name is required');
  }
  const cats = await ensureCategories();
  if (cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    res.status(400);
    throw new Error('A category with that name already exists');
  }
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'award';
  const key = `${base}-${Date.now().toString(36)}`;
  const order = Math.max(1, ...cats.map((c) => c.order || 0)) + 1;
  const category = await RnrCategory.create({
    key, name, perDepartment: !!req.body.perDepartment, order, createdBy: req.user._id,
  });
  await auditCategory(req, category, 'Created');
  res.status(201).json({ category, categories: await ensureCategories() });
});

/**
 * Delete an award category. Best Employee cannot be deleted. Drafts lose that
 * category's picks; announced awards keep them (with the name snapshot) as the
 * record.
 * @route DELETE /api/rnr/categories/:id  (HR/Admin)
 * @returns {{id: string, deleted: boolean, categories: Object[]}}
 */
const deleteCategory = asyncHandler(async (req, res) => {
  const category = await RnrCategory.findById(req.params.id);
  if (!category) {
    res.status(404);
    throw new Error('Category not found');
  }
  if (category.locked) {
    res.status(400);
    throw new Error(`${category.name} is always offered and cannot be deleted.`);
  }
  await category.deleteOne();
  await RnrAward.updateMany({ status: 'Draft' }, { $pull: { winners: { category: category.key } } });
  await auditCategory(req, category, 'deleted');
  res.json({ id: req.params.id, deleted: true, categories: await ensureCategories() });
});

module.exports = {
  listCategories,
  createCategory,
  deleteCategory,
  currentBanner,
  dismissBanner,
  listAwards,
  listPeople,
  upsertAward,
  announceAward,
  deleteAward,
};
