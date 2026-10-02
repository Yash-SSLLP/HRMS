/**
 * Training controller — instructor-led sessions (2026-10-02 rework).
 *
 * WHAT A TRAINING IS NOW. A session somebody runs from a moment to a moment,
 * for a list of employees, with a trainer (one of the staff, or anybody from
 * outside — the name alone), a category, an optional Google Meet link, files
 * handed out with it, and — once it is over — a review from every participant
 * on how clear it was.
 *
 * TWO AUDIENCES, ONE ROUTER (routes/trainingRoutes.js):
 *   · whoever holds `training.manage` books, edits and cancels sessions, keeps
 *     the category list, and downloads the monthly report;
 *   · everybody else sees the sessions THEY are on — as a participant or as the
 *     trainer — on their own My Trainings page, joins the meeting from there,
 *     downloads the files and, afterwards, leaves their review. Those routes are
 *     authorised by identity (are you on this training?), not by a capability.
 *
 * STATUS FOLLOWS THE CLOCK. Planned → Ongoing → Completed is the schedule's job
 * (liveStatus here at read time, services/trainingWorker in the database); only
 * Cancelled and an early "mark completed" are a person's. See models/Training.
 *
 * MEET LINKS work exactly as they do for interviews: pasted by hand, or created
 * through the Google Calendar API, which also emails every participant the
 * invite. A calendar-made link keeps its event id, so a reschedule, a rename or
 * a change of attendees moves that same event (Google tells the people
 * affected) and a cancellation deletes it.
 */
const path = require('path');
const asyncHandler = require('express-async-handler');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');
const Training = require('../models/Training');
const TrainingCategory = require('../models/TrainingCategory');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const { TRAINING_STATUS } = require('../models/Training');
const storage = require('../services/storage');
const googleCalendar = require('../services/googleCalendar');
const { notifyMany } = require('../services/notify');
const { hasPermission, isPortalViewer } = require('../middleware/authMiddleware');
// Company wall: Training.participants refs User, so the User-keyed helper applies.
const { allowedUserIds } = require('../utils/employeeScope');
const { pickableUserFilter } = require('../utils/peoplePicker');
const { departedUserIdSet } = require('../utils/departed');
// IST day/month boundaries — the company's calendar, and what a bare date means.
const { istDayRange, istMonthRange } = require('../utils/istDate');

const USER_FIELDS = 'firstName lastName email role';
/** A training with no end time is assumed to run this long. */
const DEFAULT_LENGTH_MIN = 60;
/** Join is "on" from this long before the start until this long after the end. */
const JOIN_EARLY_MIN = 30;
const JOIN_LATE_MIN = 30;
/** Most files one training may carry (they live in GridFS — see trainingRoutes). */
const MAX_FILES = 10;
const IST_OFFSET_MS = 330 * 60 * 1000;

const idOf = (v) => String(v?._id || v || '');
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const personName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');

// ─── time ─────────────────────────────────────────────────────────────────

/**
 * A training's start/end as an absolute instant.
 *
 * 'YYYY-MM-DD' and '…T09:30' do not mean the same kind of thing, and only one
 * of them is ambiguous: `new Date('2026-09-23')` is UTC midnight — 05:30 IST.
 * A bare date is pinned to IST midnight here, at the only place that sees the
 * raw request, so every "no time was set" value has one shape. Bare dates are
 * not legacy: older Android builds still send them.
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
 * Normalise both dates on an incoming body and refuse a backwards range —
 * checked here because it is the only place both clients pass through.
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
  // the start can invert it against an end nobody touched.
  const s = start !== undefined ? start : existing.startDate;
  const e = end !== undefined ? end : existing.endDate;
  if (s && e && new Date(e) < new Date(s)) {
    res.status(400);
    throw new Error('A training cannot end before it starts.');
  }
};

/** When the session ends — its end time, or a default hour after the start. */
function effectiveEnd(t) {
  if (t.endDate) return new Date(t.endDate);
  if (t.startDate) return new Date(new Date(t.startDate).getTime() + DEFAULT_LENGTH_MIN * 60000);
  return null;
}

/** Scheduled length in minutes ("time taken"), or null without both ends. */
function durationMinutes(t) {
  if (!t.startDate || !t.endDate) return null;
  const m = Math.round((new Date(t.endDate) - new Date(t.startDate)) / 60000);
  return m >= 0 ? m : null;
}

/**
 * Where a training stands right now. Cancelled, and a Completed somebody set by
 * hand (completedAt), are decisions; everything else is read off the clock — so
 * a session booked for 7 pm reads Live at 7 and Completed at the end without
 * anybody touching it. A training with no start date keeps what was stored.
 * @param {object} t
 * @param {number} [now]
 * @returns {'Planned'|'Ongoing'|'Completed'|'Cancelled'}
 */
function liveStatus(t, now = Date.now()) {
  if (t.status === 'Cancelled') return 'Cancelled';
  if (t.status === 'Completed' && t.completedAt) return 'Completed';
  if (!t.startDate) return TRAINING_STATUS.includes(t.status) ? t.status : 'Planned';
  const s = new Date(t.startDate).getTime();
  const e = effectiveEnd(t).getTime();
  if (now < s) return 'Planned';
  if (now >= e) return 'Completed';
  return 'Ongoing';
}

/** Is the Join button "on" for this training right now? */
function joinOpen(t, now = Date.now()) {
  if (!t.meetingLink || liveStatus(t, now) === 'Cancelled') return false;
  if (!t.startDate) return true;
  const s = new Date(t.startDate).getTime() - JOIN_EARLY_MIN * 60000;
  const e = effectiveEnd(t).getTime() + JOIN_LATE_MIN * 60000;
  if (t.status === 'Completed' && t.completedAt) return now >= s && now <= new Date(t.completedAt).getTime() + JOIN_LATE_MIN * 60000;
  return now >= s && now <= e;
}

const IST_WHEN = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
});
// en-IN prints "pm" on the server's ICU and "PM" in the browsers — one casing.
const upperMeridiem = (s) => s.replace(/\b([ap])\.?\s?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`);
/** "Tue, 7 Oct, 7:00 PM" in IST. */
const whenText = (d) => (d ? upperMeridiem(IST_WHEN.format(new Date(d))) : 'Date to be announced');
/** "7:00 PM" in IST. */
const timeText = (d) => (d ? upperMeridiem(IST_TIME.format(new Date(d))) : '');

/** An instant as the portal's wall clock, for a spreadsheet cell (Excel has no zones). */
const istCell = (d) => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : new Date(t + IST_OFFSET_MS);
};

// ─── status on save ───────────────────────────────────────────────────────

/**
 * Apply what the client asked the status to be. New clients send a status only
 * for an ACTION (cancel, restore, mark completed); the app builds already
 * installed send the stored status back on every edit, which is why "the same
 * as now" must change nothing.
 * @param {object} t - the Training document (mutated)
 * @param {string|undefined} requested
 * @param {number} now
 */
function applyStatusRequest(t, requested, now) {
  if (!requested) return;
  if (requested === 'Cancelled') { t.status = 'Cancelled'; return; }
  if (requested === 'Completed') {
    if (!(t.status === 'Completed' && t.completedAt) && liveStatus(t, now) !== 'Completed') {
      // Finished early: stamp it, and pull the end in to now so the report's
      // "time taken" is the real length of the session, not the booked one.
      t.completedAt = new Date(now);
      const s = t.startDate ? new Date(t.startDate).getTime() : null;
      if (s !== null && s <= now && now < effectiveEnd(t).getTime()) t.endDate = new Date(now);
    }
    t.status = 'Completed';
    return;
  }
  // Planned/Ongoing — "follow the clock": restores a cancelled training and
  // reopens one marked completed by hand.
  if (t.status === 'Cancelled') t.status = 'Planned';
  if (t.completedAt) t.completedAt = undefined;
}

/** Re-derive Planned/Ongoing/Completed from the schedule, leaving decisions alone. */
function deriveClockStatus(t, now) {
  if (t.status === 'Cancelled') return;
  if (t.status === 'Completed' && t.completedAt) return;
  const plain = typeof t.toObject === 'function' ? t.toObject() : t;
  t.status = liveStatus({ ...plain, status: 'Planned', completedAt: null }, now);
}

// ─── shaping ──────────────────────────────────────────────────────────────

const avg1 = (nums) => {
  const xs = nums.filter((n) => Number.isFinite(n) && n > 0);
  if (!xs.length) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
};

/** Averages + count over a feedback list (already narrowed to what may be seen). */
function feedbackSummary(list = []) {
  const distribution = [0, 0, 0, 0, 0];
  list.forEach((f) => { if (f.clarity >= 1 && f.clarity <= 5) distribution[f.clarity - 1] += 1; });
  return {
    count: list.length,
    clarity: avg1(list.map((f) => f.clarity)),
    usefulness: avg1(list.map((f) => f.usefulness)),
    trainerRating: avg1(list.map((f) => f.trainerRating)),
    distribution,
  };
}

const shapeFiles = (t) => (t.attachments || []).map((a) => ({
  _id: a._id, name: a.name, mime: a.mime, size: a.size, uploadedAt: a.uploadedAt,
}));

const shapeTrainer = (t) => {
  const u = t.trainerUser && typeof t.trainerUser === 'object' && t.trainerUser.firstName ? t.trainerUser : null;
  return {
    trainer: t.trainer || (u ? personName(u) : ''),
    trainerUser: u ? { _id: u._id, firstName: u.firstName, lastName: u.lastName } : (t.trainerUser ? { _id: t.trainerUser } : null),
    trainerType: t.trainerUser ? 'employee' : (t.trainer ? 'external' : null),
  };
};

/**
 * One training for the people who run training. Participants are narrowed to
 * the viewer's company wall (titles and dates are shared config; attendees are
 * people-data), and every count is taken over the same visible set.
 * @param {object} t - lean, participants + trainerUser populated
 * @param {string[]|null} ids - allowedUserIds (null = everyone)
 * @param {number} now
 */
function shapeForManager(t, ids, now) {
  const visible = (uid) => !ids || ids.includes(idOf(uid));
  const participants = (t.participants || []).filter((p) => p && visible(p._id || p));
  const pset = new Set(participants.map((p) => idOf(p)));
  const attendance = (t.attendance || []).filter((a) => pset.has(idOf(a.user)));
  const feedback = (t.feedback || []).filter((f) => visible(f.user));
  return {
    _id: t._id,
    title: t.title,
    description: t.description || '',
    category: t.category || '',
    ...shapeTrainer(t),
    startDate: t.startDate || null,
    endDate: t.endDate || null,
    durationMinutes: durationMinutes(t),
    status: liveStatus(t, now),
    completedAt: t.completedAt || null,
    meetingLink: t.meetingLink || '',
    meetAuto: !!t.meetEventId,
    joinOpen: joinOpen(t, now),
    attachments: shapeFiles(t),
    participants,
    participantCount: participants.length,
    attendedCount: attendance.length,
    feedbackSummary: feedbackSummary(feedback),
    createdBy: t.createdBy && typeof t.createdBy === 'object'
      ? { _id: t.createdBy._id, name: personName(t.createdBy) } : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** Employee code / department / designation for a set of user ids. */
async function profilesByUser(userIds) {
  const ids = [...new Set(userIds.map(idOf).filter(isId))];
  if (!ids.length) return new Map();
  const rows = await EmployeeProfile.find({ user: { $in: ids } })
    .select('user employeeCode department designation').lean();
  return new Map(rows.map((p) => [idOf(p.user), p]));
}

const POP_LIST = [
  { path: 'participants', select: USER_FIELDS },
  { path: 'trainerUser', select: 'firstName lastName email' },
  { path: 'createdBy', select: 'firstName lastName' },
];

/** Categories in the managed list, alphabetical. */
const categoryList = async () => (await TrainingCategory.find({}).sort({ key: 1 }).lean())
  .map((c) => ({ _id: c._id, name: c.name }));

/** Make sure a typed category exists in the list (the form may name a new one). */
async function ensureCategory(name, userId) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const key = clean.toLowerCase();
  const found = await TrainingCategory.findOne({ key }).lean();
  if (found) return found.name;
  try {
    const made = await TrainingCategory.create({ name: clean, createdBy: userId });
    return made.name;
  } catch (err) {
    // Two saves racing on the same new name — the other one won; use it.
    if (err?.code === 11000) return (await TrainingCategory.findOne({ key }).lean())?.name || clean;
    throw err;
  }
}

// ─── notifications ────────────────────────────────────────────────────────

/**
 * Tell people about a training. Bell + push, landing on My Trainings. Flagged
 * `action` because being booked on a session is something to turn up to — a
 * CEO/MD participant must see it too (services/notify drops FYI rows for them).
 * The person who made the change is never told about their own edit.
 */
function tell(userIds, { title, body }, exceptId) {
  const ids = [...new Set((userIds || []).map(idOf).filter(isId))].filter((id) => id !== idOf(exceptId));
  if (!ids.length) return;
  notifyMany(ids, { type: 'training', title, body, link: 'trainings', action: true }).catch(() => {});
}

const trainerBit = (t) => (t.trainer ? ` · Trainer: ${t.trainer}` : '');

// ─── Google Calendar ──────────────────────────────────────────────────────

/** Everyone a training's calendar event should invite. */
async function attendeeEmails(t, extraUserIds = []) {
  const ids = [...(t.participants || []), t.trainerUser, ...extraUserIds].map(idOf).filter(isId);
  if (!ids.length) return [];
  const rows = await User.find({ _id: { $in: [...new Set(ids)] } }).select('email').lean();
  return rows.map((u) => u.email).filter(Boolean);
}

function eventText(t) {
  const lines = [];
  if (t.category) lines.push(`Category: ${t.category}`);
  if (t.trainer) lines.push(`Trainer: ${t.trainer}`);
  if (t.description) lines.push('', String(t.description).slice(0, 1500));
  lines.push('', 'Join with Google Meet using the link in this invitation, or from My Trainings in the HRMS portal.');
  return { summary: `Training: ${t.title}`, description: lines.join('\n') };
}

/**
 * Mint a Meet link (and its calendar invites) for a training.
 * @returns {Promise<string>} the link
 * @throws {Error} when Google is unconfigured or refuses
 */
async function createMeetFor(t, actorId) {
  if (!googleCalendar.isConfigured()) {
    throw new Error('Google Meet is not configured on the server. Paste a meeting link instead.');
  }
  const start = t.startDate ? new Date(t.startDate) : new Date(Date.now() + 15 * 60000);
  const end = effectiveEnd({ ...t, startDate: start }) || new Date(start.getTime() + DEFAULT_LENGTH_MIN * 60000);
  const result = await googleCalendar.createMeetEvent({
    ...eventText(t),
    start,
    end,
    attendees: await attendeeEmails(t, actorId ? [actorId] : []),
  });
  t.meetingLink = result.meetingLink;
  t.meetEventId = result.eventId;
  return result.meetingLink;
}

// ─── manager: list / detail / people ──────────────────────────────────────

/**
 * Every training (or one month's, or one status's), newest start first, with
 * the category list and whether Google Meet can be created — everything the
 * page needs in one round trip.
 * @route GET /api/training   (training.manage)
 * @param {string} [req.query.status] - a live status
 * @param {string} [req.query.month] - 'YYYY-MM' (IST)
 * @returns {{count, trainings, categories, meetAvailable}}
 */
const listTrainings = asyncHandler(async (req, res) => {
  const filter = {};
  const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ''));
  if (m) {
    const [from, to] = istMonthRange(Number(m[1]), Number(m[2]));
    filter.startDate = { $gte: from, $lt: to };
  }
  const rows = await Training.find(filter)
    .select('-feedback.comment')
    .populate(POP_LIST)
    .sort({ startDate: -1, createdAt: -1 })
    .lean();
  const ids = await allowedUserIds(req);
  const now = Date.now();
  let trainings = rows.map((t) => shapeForManager(t, ids, now));
  if (req.query.status) trainings = trainings.filter((t) => t.status === req.query.status);
  res.json({
    count: trainings.length,
    trainings,
    categories: await categoryList(),
    meetAvailable: googleCalendar.isConfigured(),
  });
});

/**
 * One training in full: who is on it (with employee code, department and
 * designation), who joined, and every review with its comment.
 * @route GET /api/training/:id   (training.manage)
 */
const getTraining = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id)
    .populate(POP_LIST)
    .populate('attendance.user', 'firstName lastName')
    .populate('feedback.user', 'firstName lastName')
    .lean();
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const ids = await allowedUserIds(req);
  const now = Date.now();
  const base = shapeForManager(t, ids, now);
  const pset = new Set(base.participants.map((p) => idOf(p)));
  const profiles = await profilesByUser([...pset, ...(t.feedback || []).map((f) => f.user)]);
  const joinedBy = new Map((t.attendance || []).map((a) => [idOf(a.user), a]));
  const reviewBy = new Map((t.feedback || []).map((f) => [idOf(f.user), f]));
  const enrich = (u) => {
    const p = profiles.get(idOf(u)) || {};
    return { employeeCode: p.employeeCode || '', department: p.department || '', designation: p.designation || '' };
  };
  res.json({
    training: {
      ...base,
      participants: base.participants.map((u) => {
        const a = joinedBy.get(idOf(u));
        const f = reviewBy.get(idOf(u));
        return {
          ...u,
          ...enrich(u),
          joinedAt: a?.firstJoinedAt || null,
          joins: a?.joins || 0,
          reviewed: !!f,
        };
      }),
      feedback: (t.feedback || [])
        .filter((f) => !ids || ids.includes(idOf(f.user)))
        .map((f) => ({
          user: f.user && f.user.firstName ? { _id: f.user._id, firstName: f.user.firstName, lastName: f.user.lastName } : { _id: f.user },
          ...enrich(f.user),
          clarity: f.clarity,
          usefulness: f.usefulness || null,
          trainerRating: f.trainerRating || null,
          comment: f.comment || '',
          submittedAt: f.updatedAt || f.submittedAt,
        }))
        .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)),
    },
  });
});

/**
 * The people who can be put on a training — and who can be picked as its
 * trainer. ITS OWN ROUTE, not GET /admin/users (role-gated: an Employee holding
 * the standalone Training grant would find nobody to add). `pickableUserFilter`
 * carries the easy-to-forget rules — active only, no system logins, executives
 * only if opted in — and the company wall; anyone already gone is dropped.
 * Each row now carries employee code, department and designation, so the
 * picker can group by department and search by code.
 * @route GET /api/training/people   (training.manage)
 * @returns {{count: number, users: Object[]}}
 */
const listTrainingPeople = asyncHandler(async (req, res) => {
  const rows = await User.find(await pickableUserFilter(req))
    .select(USER_FIELDS)
    .sort({ firstName: 1, lastName: 1 })
    .lean();
  const gone = await departedUserIdSet(rows.map((u) => u._id));
  const kept = rows.filter((u) => !gone.has(String(u._id)));
  const profiles = await profilesByUser(kept.map((u) => u._id));
  const users = kept.map((u) => {
    const p = profiles.get(idOf(u)) || {};
    return { ...u, employeeCode: p.employeeCode || '', department: p.department || '', designation: p.designation || '' };
  });
  // The list carries the executives (a CEO may well RUN a session, so the
  // trainer picker wants them); whether they belong in the PARTICIPANT picker
  // is the org's call — the SuperAdmin's includeExecutivesInLists switch —
  // and the clients apply it there. `?excludeExecutives=true` still drops them
  // here outright for a caller that wants neither.
  const Setting = require('../models/Setting');
  const settings = await Setting.getSettings().catch(() => ({}));
  res.json({ count: users.length, users, includeExecutives: !!settings.includeExecutivesInLists });
});

// ─── manager: create / update / delete ────────────────────────────────────

/**
 * Resolve the trainer fields of a body against the stored training.
 * `trainerUser` (an id, or null for "not one of the staff") wins; a bare
 * `trainer` name from an older client keeps the staff link only while the name
 * still matches it.
 */
async function applyTrainer(t, body, res) {
  const hasUser = Object.prototype.hasOwnProperty.call(body, 'trainerUser');
  const hasName = Object.prototype.hasOwnProperty.call(body, 'trainer');
  if (hasUser) {
    const uid = body.trainerUser ? String(body.trainerUser._id || body.trainerUser) : '';
    if (uid) {
      if (!isId(uid)) { res.status(400); throw new Error('That trainer could not be found.'); }
      const u = await User.findById(uid).select('firstName lastName').lean();
      if (!u) { res.status(400); throw new Error('That trainer could not be found.'); }
      t.trainerUser = u._id;
      t.trainer = personName(u);
    } else {
      t.trainerUser = null;
      t.trainer = hasName ? String(body.trainer || '').trim() : '';
    }
  } else if (hasName) {
    const name = String(body.trainer || '').trim();
    if (t.trainerUser && name !== (t.trainer || '')) t.trainerUser = null;
    t.trainer = name;
  }
  delete body.trainer;
  delete body.trainerUser;
}

/** Clean a submitted participant list: ids only, once each. */
const cleanParticipants = (list) => [...new Set((Array.isArray(list) ? list : [])
  .map((p) => String(p?._id || p || '')).filter(isId))];

/** Fields a client may set directly. Everything else goes through a rule. */
const PLAIN_FIELDS = ['title', 'description', 'startDate', 'endDate', 'meetingLink'];

/**
 * Create a training. Everyone on it — and an internal trainer — is told at
 * once; with `createMeet: true` a Google Meet is minted too (invites by email).
 * @route POST /api/training   (training.manage)
 * @returns {{training, warning?}} (201)
 */
const createTraining = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  if (!String(body.title || '').trim()) {
    res.status(400);
    throw new Error('Give the training a title.');
  }
  if (body.status && !TRAINING_STATUS.includes(body.status)) {
    res.status(400);
    throw new Error(`status must be one of ${TRAINING_STATUS.join(', ')}`);
  }
  normaliseDates(body, res);
  const now = Date.now();
  const t = new Training({ createdBy: req.user._id });
  PLAIN_FIELDS.forEach((k) => { if (body[k] !== undefined) t[k] = body[k]; });
  t.title = String(body.title).trim();
  t.meetingLink = String(body.meetingLink || '').trim();
  if (body.category !== undefined) t.category = await ensureCategory(body.category, req.user._id);
  await applyTrainer(t, body, res);
  t.participants = cleanParticipants(body.participants);
  applyStatusRequest(t, body.status === 'Planned' || body.status === 'Ongoing' ? undefined : body.status, now);
  deriveClockStatus(t, now);

  let warning = null;
  if (body.createMeet && !t.meetingLink && t.status !== 'Cancelled') {
    try { await createMeetFor(t, req.user._id); } catch (err) { warning = `Saved, but the Google Meet link could not be created: ${err.message}`; }
  }
  await t.save();

  if (t.status !== 'Cancelled' && liveStatus(t, now) !== 'Completed') {
    const when = whenText(t.startDate);
    const link = t.meetingLink ? ' Join link, details and files are in My Trainings.' : ' Details and files are in My Trainings.';
    tell(t.participants, { title: `New training: ${t.title}`, body: `${when}${trainerBit(t)}.${link}` }, req.user._id);
    if (t.trainerUser) {
      tell([t.trainerUser], {
        title: `You are the trainer: ${t.title}`,
        body: `${when} · ${t.participants.length} participant${t.participants.length === 1 ? '' : 's'}. Details in My Trainings.`,
      }, req.user._id);
    }
  }
  res.status(201).json({ training: t, warning });
});

/**
 * Update a training (partial). Status is an ACTION here (cancel / restore /
 * mark completed); otherwise it follows the clock. People are told what
 * changed for them: newly added → "new training", a moved slot → "rescheduled",
 * a cancellation, a restoration, a join link that has just appeared. A calendar
 * event behind the link is moved to match (Google mails the attendees).
 * @route PUT /api/training/:id   (training.manage)
 * @returns {{training, warning?}}
 */
const updateTraining = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id);
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const body = { ...req.body };
  delete body.createdBy;
  if (body.status && !TRAINING_STATUS.includes(body.status)) {
    res.status(400);
    throw new Error(`status must be one of ${TRAINING_STATUS.join(', ')}`);
  }
  normaliseDates(body, res, t);
  const now = Date.now();

  const before = {
    participants: new Set((t.participants || []).map(idOf)),
    start: t.startDate ? new Date(t.startDate).getTime() : null,
    end: t.endDate ? new Date(t.endDate).getTime() : null,
    status: liveStatus(t, now),
    link: t.meetingLink || '',
    trainerUser: idOf(t.trainerUser),
    title: t.title,
    eventId: t.meetEventId || null,
  };

  if (body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title) { res.status(400); throw new Error('Give the training a title.'); }
    t.title = title;
  }
  if (body.description !== undefined) t.description = String(body.description || '').trim();
  if (body.startDate !== undefined) t.startDate = body.startDate;
  if (body.endDate !== undefined) t.endDate = body.endDate;
  if (body.category !== undefined) t.category = await ensureCategory(body.category, req.user._id);
  await applyTrainer(t, body, res);

  // Company wall, write side: a walled admin was only shown their own
  // company's participants, so their submission replaces only that subset.
  if (body.participants !== undefined) {
    let next = cleanParticipants(body.participants);
    const ids = await allowedUserIds(req);
    if (ids) {
      const keep = (t.participants || []).map(idOf).filter((p) => !ids.includes(p));
      next = [...keep, ...next.filter((p) => ids.includes(p))];
    }
    t.participants = [...new Set(next)];
  }

  // A link typed in replaces the calendar's own: the event it came with is
  // deleted below so nobody keeps an invite to a meeting that is not used.
  let dropEvent = null;
  if (body.meetingLink !== undefined) {
    const link = String(body.meetingLink || '').trim();
    if (link !== (t.meetingLink || '')) {
      if (t.meetEventId) dropEvent = t.meetEventId;
      t.meetEventId = undefined;
    }
    t.meetingLink = link;
  }

  // Compared to the MINUTE: both forms work in whole minutes, so a stored time
  // carrying seconds (an older booking, an import) must not read as "moved"
  // the first time somebody saves it unchanged — that sent everyone on the
  // training a "rescheduled" notice for nothing.
  const minuteOf = (ms) => (ms === null ? null : Math.floor(ms / 60000));
  const timesChanged = minuteOf(t.startDate ? new Date(t.startDate).getTime() : null) !== minuteOf(before.start)
    || minuteOf(t.endDate ? new Date(t.endDate).getTime() : null) !== minuteOf(before.end);
  // Moved into the future: whatever "completed" meant no longer applies, and
  // both one-off notices should fire again for the new slot.
  if (timesChanged) {
    if (t.startDate && new Date(t.startDate).getTime() > now) {
      if (t.completedAt) t.completedAt = undefined;
      t.reminderSentAt = undefined;
    }
    if (effectiveEnd(t) && effectiveEnd(t).getTime() > now) t.feedbackAskedAt = undefined;
  }
  // A status equal to the one the client was SHOWN is an echo, not an action —
  // the app builds already installed send the loaded status back on every
  // save. Treating that echo as "mark completed" would pin a session just
  // moved to next week as finished.
  applyStatusRequest(t, body.status && body.status !== before.status ? body.status : undefined, now);
  deriveClockStatus(t, now);
  const after = liveStatus(t, now);

  // ── calendar ──
  let warning = null;
  const cancelled = after === 'Cancelled';
  // Called off: the calendar event goes (Google tells the attendees), and the
  // link that came WITH it goes too — it belonged to that event. A restored
  // session gets a fresh one from the form.
  if (cancelled && t.meetEventId) {
    dropEvent = dropEvent || t.meetEventId;
    t.meetEventId = undefined;
    t.meetingLink = '';
  }
  if (body.createMeet && !t.meetingLink && !cancelled) {
    try { await createMeetFor(t, req.user._id); } catch (err) { warning = `Saved, but the Google Meet link could not be created: ${err.message}`; }
  } else if (t.meetEventId && googleCalendar.isConfigured()) {
    const peopleChanged = body.participants !== undefined
      && (t.participants.length !== before.participants.size || t.participants.some((p) => !before.participants.has(idOf(p))));
    const trainerChanged = idOf(t.trainerUser) !== before.trainerUser;
    const patch = {};
    if (timesChanged) { patch.start = t.startDate; patch.end = effectiveEnd(t); }
    if (t.title !== before.title || body.description !== undefined || body.category !== undefined || trainerChanged) {
      Object.assign(patch, eventText(t));
    }
    if (peopleChanged || trainerChanged) patch.attendees = await attendeeEmails(t, [req.user._id]);
    if (Object.keys(patch).length) {
      try { await googleCalendar.updateEvent(t.meetEventId, patch); } catch (err) {
        warning = `Saved, but the calendar invite could not be updated: ${err.message}`;
      }
    }
  }
  await t.save();
  if (dropEvent && googleCalendar.isConfigured()) googleCalendar.deleteEvent(dropEvent).catch(() => {});

  // ── who to tell ──
  const nowIds = (t.participants || []).map(idOf);
  const added = nowIds.filter((id) => !before.participants.has(id));
  const stayed = nowIds.filter((id) => before.participants.has(id));
  const crew = t.trainerUser ? [...stayed, idOf(t.trainerUser)] : stayed;
  const upcoming = after === 'Planned' || after === 'Ongoing';
  const when = whenText(t.startDate);
  if (after === 'Cancelled' && before.status !== 'Cancelled') {
    if (before.status === 'Planned' || before.status === 'Ongoing') {
      tell([...nowIds, idOf(t.trainerUser)], { title: `Training cancelled: ${t.title}`, body: `${when} — this session will not take place.` }, req.user._id);
    }
  } else if (upcoming) {
    if (added.length) {
      tell(added, {
        title: `New training: ${t.title}`,
        body: `${when}${trainerBit(t)}.${t.meetingLink ? ' Join link, details and files are in My Trainings.' : ' Details and files are in My Trainings.'}`,
      }, req.user._id);
    }
    if (before.status === 'Cancelled') {
      tell(crew, { title: `Training is back on: ${t.title}`, body: `${when}. Details in My Trainings.` }, req.user._id);
    } else if (timesChanged) {
      tell(crew, { title: `Training rescheduled: ${t.title}`, body: `Now ${when}. Details in My Trainings.` }, req.user._id);
    } else if (!before.link && t.meetingLink) {
      tell(crew, { title: `Join link ready: ${t.title}`, body: `${when}. Join from My Trainings.` }, req.user._id);
    }
    if (t.trainerUser && idOf(t.trainerUser) !== before.trainerUser) {
      tell([t.trainerUser], {
        title: `You are the trainer: ${t.title}`,
        body: `${when} · ${nowIds.length} participant${nowIds.length === 1 ? '' : 's'}. Details in My Trainings.`,
      }, req.user._id);
    }
  }
  res.json({ training: t, warning });
});

/**
 * Delete a training, its files, and the calendar event behind its link.
 * @route DELETE /api/training/:id   (training.manage)
 */
const deleteTraining = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id);
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const files = (t.attachments || []).map((a) => a.storagePath).filter(Boolean);
  const eventId = t.meetEventId;
  const wasUpcoming = ['Planned', 'Ongoing'].includes(liveStatus(t));
  const people = [...(t.participants || []).map(idOf), idOf(t.trainerUser)];
  const { title, startDate } = t;
  await t.deleteOne();
  files.forEach((p) => storage.remove(p).catch(() => {}));
  if (eventId && googleCalendar.isConfigured()) googleCalendar.deleteEvent(eventId).catch(() => {});
  if (wasUpcoming) {
    tell(people, { title: `Training cancelled: ${title}`, body: `${whenText(startDate)} — this session will not take place.` }, req.user._id);
  }
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Create (or re-create) the Google Meet link for a training. Google emails the
 * invite to every participant and the trainer.
 * @route POST /api/training/:id/meet   (training.manage)
 * @returns {{training, meetingLink}}; 503 when Google is not configured
 */
const createTrainingMeet = asyncHandler(async (req, res) => {
  if (!googleCalendar.isConfigured()) {
    res.status(503);
    throw new Error('Google Meet is not configured on the server. Paste a meeting link instead.');
  }
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id);
  if (!t) { res.status(404); throw new Error('Training not found'); }
  if (liveStatus(t) === 'Cancelled') { res.status(400); throw new Error('This training is cancelled — restore it first.'); }
  const hadLink = !!t.meetingLink;
  const oldEvent = t.meetEventId;
  try {
    await createMeetFor(t, req.user._id);
  } catch (err) {
    res.status(502);
    throw new Error(err.message || 'Failed to create the Google Meet link');
  }
  await t.save();
  if (oldEvent && oldEvent !== t.meetEventId) googleCalendar.deleteEvent(oldEvent).catch(() => {});
  if (['Planned', 'Ongoing'].includes(liveStatus(t))) {
    tell([...(t.participants || []), t.trainerUser], {
      title: hadLink ? `New join link: ${t.title}` : `Join link ready: ${t.title}`,
      body: `${whenText(t.startDate)}. Join from My Trainings.`,
    }, req.user._id);
  }
  res.json({ training: t, meetingLink: t.meetingLink });
});

// ─── files ────────────────────────────────────────────────────────────────

/** ASCII-only, quote-free — a header value Node will accept. */
const headerSafeName = (name) => (path.basename(String(name || 'file')).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '') || 'file');

/**
 * Attach files to a training (multipart `files`, several at once). Everyone on
 * the training can download them from My Trainings.
 * @route POST /api/training/:id/files   (training.manage)
 * @returns {{attachments}}
 */
const uploadTrainingFiles = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id);
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const files = req.files || [];
  if (!files.length) { res.status(400); throw new Error('Choose at least one file to attach.'); }
  if ((t.attachments || []).length + files.length > MAX_FILES) {
    res.status(400);
    throw new Error(`A training can carry up to ${MAX_FILES} files — remove some first.`);
  }
  for (const f of files) {
    const saved = await storage.saveBuffer({
      buffer: f.buffer, ownerType: 'training', ownerId: t._id, originalName: f.originalname,
    });
    t.attachments.push({
      storagePath: saved.storagePath,
      name: f.originalname || 'file',
      mime: f.mimetype || 'application/octet-stream',
      size: saved.sizeBytes,
      uploadedBy: req.user._id,
      uploadedAt: new Date(),
    });
  }
  await t.save();
  res.status(201).json({ attachments: shapeFiles(t) });
});

/**
 * Remove one file from a training (and its bytes).
 * @route DELETE /api/training/:id/files/:fileId   (training.manage)
 */
const deleteTrainingFile = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id);
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const file = (t.attachments || []).find((a) => idOf(a._id) === String(req.params.fileId));
  if (!file) { res.status(404); throw new Error('That file is not on this training.'); }
  const storagePath = file.storagePath;
  t.attachments = t.attachments.filter((a) => idOf(a._id) !== String(req.params.fileId));
  await t.save();
  storage.remove(storagePath).catch(() => {});
  res.json({ attachments: shapeFiles(t) });
});

/**
 * Download one of a training's files. Open to everyone ON the training — a
 * participant or its trainer — and to whoever may see the training module.
 * Served inline (a PDF or picture opens in the browser); `?download=1` asks
 * for an attachment instead.
 * @route GET /api/training/:id/files/:fileId   (protect; checked here)
 */
const downloadTrainingFile = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id).select('participants trainerUser attachments').lean();
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const me = idOf(req.user._id);
  const onIt = (t.participants || []).some((p) => idOf(p) === me) || idOf(t.trainerUser) === me;
  if (!onIt && !hasPermission(req.user, 'training.manage') && !isPortalViewer(req.user)) {
    res.status(403);
    throw new Error('This file belongs to a training you are not on.');
  }
  const file = (t.attachments || []).find((a) => idOf(a._id) === String(req.params.fileId));
  if (!file) { res.status(404); throw new Error('That file is not on this training.'); }
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${disposition}; filename="${headerSafeName(file.name)}"`);
  if (file.size) res.setHeader('Content-Length', file.size);
  if (await storage.streamTo(file.storagePath, res)) return;
  res.status(404).json({ message: 'File not found' });
});

// ─── categories ───────────────────────────────────────────────────────────

/**
 * The category list, each with how many trainings use it.
 * @route GET /api/training/categories   (training.manage)
 */
const listCategories = asyncHandler(async (req, res) => {
  const [cats, usage] = await Promise.all([
    categoryList(),
    Training.aggregate([{ $match: { category: { $nin: [null, ''] } } }, { $group: { _id: { $toLower: '$category' }, n: { $sum: 1 } } }]),
  ]);
  const used = new Map(usage.map((u) => [u._id, u.n]));
  res.json({ categories: cats.map((c) => ({ ...c, trainings: used.get(c.name.toLowerCase()) || 0 })) });
});

/**
 * Add a category. Asking for one that already exists (in any case) returns it.
 * @route POST /api/training/categories   (training.manage)
 */
const createCategory = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
  if (!name) { res.status(400); throw new Error('Type a name for the category.'); }
  if (name.length > 60) { res.status(400); throw new Error('Keep the category name under 60 characters.'); }
  const saved = await ensureCategory(name, req.user._id);
  const cat = await TrainingCategory.findOne({ key: saved.toLowerCase() }).lean();
  res.status(201).json({ category: { _id: cat._id, name: cat.name }, categories: await categoryList() });
});

/**
 * Rename a category — and every training filed under it, so the two never
 * disagree.
 * @route PUT /api/training/categories/:id   (training.manage)
 */
const renameCategory = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Category not found'); }
  const cat = await TrainingCategory.findById(req.params.id);
  if (!cat) { res.status(404); throw new Error('Category not found'); }
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
  if (!name) { res.status(400); throw new Error('Type a name for the category.'); }
  if (name.length > 60) { res.status(400); throw new Error('Keep the category name under 60 characters.'); }
  const clash = await TrainingCategory.findOne({ key: name.toLowerCase(), _id: { $ne: cat._id } }).lean();
  if (clash) { res.status(409); throw new Error(`There is already a category called "${clash.name}".`); }
  const old = cat.name;
  cat.name = name;
  await cat.save();
  const escaped = old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await Training.updateMany({ category: new RegExp(`^${escaped}$`, 'i') }, { $set: { category: name } });
  res.json({ category: { _id: cat._id, name: cat.name }, categories: await categoryList() });
});

/**
 * Take a category off the list. Trainings already filed under it keep the
 * name — history is not rewritten — it just stops being offered.
 * @route DELETE /api/training/categories/:id   (training.manage)
 */
const deleteCategory = asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Category not found'); }
  const cat = await TrainingCategory.findByIdAndDelete(req.params.id);
  if (!cat) { res.status(404); throw new Error('Category not found'); }
  res.json({ id: req.params.id, deleted: true, categories: await categoryList() });
});

// ─── employee: My Trainings, join, feedback ───────────────────────────────

/**
 * The trainings I am on — as a participant, as the trainer, or both — with
 * what I need on the day: the join link (unless it was called off), the files,
 * my own attendance and review, and whether either action is open now. A
 * trainer also sees how their session was rated (averages only, no names).
 * @route GET /api/training/mine   (protect)
 * @returns {{trainings: Object[]}}
 */
const myTrainings = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const rows = await Training.find({ $or: [{ participants: me }, { trainerUser: me }] })
    .populate('trainerUser', 'firstName lastName')
    .sort({ startDate: -1, createdAt: -1 })
    .lean();
  const now = Date.now();
  const mine = idOf(me);
  const trainings = rows.map((t) => {
    const status = liveStatus(t, now);
    const participant = (t.participants || []).some((p) => idOf(p) === mine);
    const trainerMe = idOf(t.trainerUser) === mine;
    const att = (t.attendance || []).find((a) => idOf(a.user) === mine);
    const fb = (t.feedback || []).find((f) => idOf(f.user) === mine);
    return {
      _id: t._id,
      title: t.title,
      description: t.description || '',
      category: t.category || '',
      ...shapeTrainer(t),
      startDate: t.startDate || null,
      endDate: t.endDate || null,
      durationMinutes: durationMinutes(t),
      status,
      meetingLink: status === 'Cancelled' ? '' : (t.meetingLink || ''),
      joinOpen: joinOpen(t, now),
      attachments: status === 'Cancelled' ? [] : shapeFiles(t),
      participantCount: (t.participants || []).length,
      role: { participant, trainer: trainerMe },
      myAttendance: att ? { firstJoinedAt: att.firstJoinedAt, joins: att.joins } : null,
      myFeedback: fb ? {
        clarity: fb.clarity, usefulness: fb.usefulness || null, trainerRating: fb.trainerRating || null,
        comment: fb.comment || '', submittedAt: fb.updatedAt || fb.submittedAt,
      } : null,
      canGiveFeedback: participant && (status === 'Completed' || status === 'Ongoing'),
      feedbackSummary: trainerMe ? (({ distribution, ...rest }) => rest)(feedbackSummary(t.feedback || [])) : undefined,
    };
  });
  res.json({ trainings });
});

/** The training, if the caller is on it; 404/403 otherwise. */
async function loadMine(req, res, select) {
  if (!isId(req.params.id)) { res.status(404); throw new Error('Training not found'); }
  const t = await Training.findById(req.params.id).select(select).lean();
  if (!t) { res.status(404); throw new Error('Training not found'); }
  const me = idOf(req.user._id);
  const participant = (t.participants || []).some((p) => idOf(p) === me);
  const trainer = idOf(t.trainerUser) === me;
  if (!participant && !trainer) { res.status(403); throw new Error('You are not on this training.'); }
  return { t, participant, trainer };
}

/**
 * Open the meeting from My Trainings — and, while the session is on (half an
 * hour either side), record that I joined. That record is the attendance the
 * monthly report shows: the portal cannot see inside Google Meet.
 * @route POST /api/training/:id/join   (protect; participant or trainer)
 * @returns {{meetingLink, recorded}}
 */
const joinTraining = asyncHandler(async (req, res) => {
  const { t } = await loadMine(req, res, 'participants trainerUser startDate endDate status completedAt meetingLink');
  if (liveStatus(t) === 'Cancelled') { res.status(400); throw new Error('This training was cancelled.'); }
  if (!t.meetingLink) { res.status(400); throw new Error('There is no meeting link for this training yet.'); }
  let recorded = false;
  if (joinOpen(t)) {
    const now = new Date();
    const me = req.user._id;
    const bump = await Training.updateOne(
      { _id: t._id, 'attendance.user': me },
      { $set: { 'attendance.$.lastJoinedAt': now }, $inc: { 'attendance.$.joins': 1 } }
    );
    if (!bump.matchedCount) {
      await Training.updateOne(
        { _id: t._id, 'attendance.user': { $ne: me } },
        { $push: { attendance: { user: me, firstJoinedAt: now, lastJoinedAt: now, joins: 1 } } }
      );
    }
    recorded = true;
  }
  res.json({ meetingLink: t.meetingLink, recorded });
});

const rating = (v, required) => {
  if (v === undefined || v === null || v === '' || v === 0) {
    if (required) return NaN;
    return undefined;
  }
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : NaN;
};

/**
 * My review of a training, once it has begun (the page asks after it ends).
 * Saving again replaces the earlier answers.
 * @route POST /api/training/:id/feedback   (protect; participants)
 * @param {number} req.body.clarity - 1-5, required
 * @param {number} [req.body.usefulness] - 1-5
 * @param {number} [req.body.trainerRating] - 1-5
 * @param {string} [req.body.comment]
 * @returns {{myFeedback}}
 */
const submitFeedback = asyncHandler(async (req, res) => {
  const { t, participant } = await loadMine(req, res, 'participants trainerUser startDate endDate status completedAt');
  if (!participant) { res.status(403); throw new Error('Only participants review a training.'); }
  const status = liveStatus(t);
  if (status === 'Cancelled') { res.status(400); throw new Error('This training was cancelled.'); }
  if (status === 'Planned') { res.status(400); throw new Error('You can review the training once it has taken place.'); }
  const clarity = rating(req.body.clarity, true);
  const usefulness = rating(req.body.usefulness, false);
  const trainerRating = rating(req.body.trainerRating, false);
  if (Number.isNaN(clarity)) { res.status(400); throw new Error('Rate how clear the training was (1 to 5).'); }
  if (Number.isNaN(usefulness) || Number.isNaN(trainerRating)) { res.status(400); throw new Error('Ratings go from 1 to 5.'); }
  const comment = String(req.body.comment || '').trim().slice(0, 2000);
  const now = new Date();
  const me = req.user._id;
  const answers = { clarity, usefulness: usefulness || null, trainerRating: trainerRating || null, comment };
  const set = Object.fromEntries(Object.entries(answers).map(([k, v]) => [`feedback.$.${k}`, v]));
  const upd = await Training.updateOne({ _id: t._id, 'feedback.user': me }, { $set: { ...set, 'feedback.$.updatedAt': now } });
  if (!upd.matchedCount) {
    await Training.updateOne(
      { _id: t._id, 'feedback.user': { $ne: me } },
      { $push: { feedback: { user: me, ...answers, submittedAt: now } } }
    );
  }
  res.json({ myFeedback: { ...answers, submittedAt: now } });
});

// ─── report ───────────────────────────────────────────────────────────────

const styleHead = (ws) => {
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 22;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
};

const hm = (min) => {
  if (min === null || min === undefined) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

/**
 * The month's training report, as an Excel workbook:
 *   Trainings     one row per session — date, start, end, TIME TAKEN, category,
 *                 trainer, participants (count and names), joined, reviews and
 *                 the average ratings, link, files, who booked it;
 *   Participants  one row per person per session — code, department, joined?,
 *                 when, and their review with its comment;
 *   Summary       the month in figures, by category and by trainer.
 * Cancelled sessions are listed (so the month is complete) but never counted.
 * @route GET /api/training/export?month=YYYY-MM   (training.manage)
 */
const exportTrainings = asyncHandler(async (req, res) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ''));
  const nowParts = new Date(Date.now() + IST_OFFSET_MS);
  const year = m ? Number(m[1]) : nowParts.getUTCFullYear();
  const month = m ? Number(m[2]) : nowParts.getUTCMonth() + 1;
  if (month < 1 || month > 12) { res.status(400); throw new Error('Pick a valid month.'); }
  const [from, to] = istMonthRange(year, month);
  const monthLabel = new Date(Date.UTC(year, month - 1, 15)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  const rows = await Training.find({ startDate: { $gte: from, $lt: to } })
    .populate(POP_LIST)
    .sort({ startDate: 1 })
    .lean();
  const ids = await allowedUserIds(req);
  const visible = (uid) => !ids || ids.includes(idOf(uid));
  const now = Date.now();
  const allPeople = new Set();
  rows.forEach((t) => (t.participants || []).forEach((p) => { if (p && visible(p._id)) allPeople.add(idOf(p)); }));
  const profiles = await profilesByUser([...allPeople]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();

  // The Summary sheet is ADDED first so it is the tab the file opens on — it is
  // what a reader wants — and filled last, once the sessions have been counted.
  const sm = wb.addWorksheet('Summary');

  // ── Sheet 2: the sessions ──
  const ws = wb.addWorksheet('Trainings');
  ws.columns = [
    { header: '#', key: 'serial', width: 5 },
    { header: 'Training', key: 'title', width: 36 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Trainer', key: 'trainer', width: 22 },
    { header: 'Trainer type', key: 'trainerType', width: 13 },
    { header: 'Date', key: 'date', width: 13, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Start', key: 'start', width: 11, style: { numFmt: 'hh:mm AM/PM' } },
    { header: 'End', key: 'end', width: 11, style: { numFmt: 'hh:mm AM/PM' } },
    { header: 'Time taken', key: 'taken', width: 11 },
    { header: 'Minutes', key: 'minutes', width: 9 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Participants', key: 'pCount', width: 12 },
    { header: 'Joined', key: 'joined', width: 9 },
    { header: 'Reviews', key: 'reviews', width: 9 },
    { header: 'Avg clarity', key: 'clarity', width: 11 },
    { header: 'Avg usefulness', key: 'usefulness', width: 13 },
    { header: 'Avg trainer', key: 'trainerAvg', width: 11 },
    { header: 'Participant names', key: 'names', width: 48 },
    { header: 'Meeting link', key: 'link', width: 32 },
    { header: 'Files', key: 'files', width: 7 },
    { header: 'Booked by', key: 'by', width: 20 },
    { header: 'Description', key: 'description', width: 50 },
  ];

  const ps = wb.addWorksheet('Participants');
  ps.columns = [
    { header: 'Training', key: 'title', width: 34 },
    { header: 'Date', key: 'date', width: 13, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Time taken', key: 'taken', width: 11 },
    { header: 'Trainer', key: 'trainer', width: 20 },
    { header: 'Participant', key: 'name', width: 24 },
    { header: 'Employee code', key: 'code', width: 14 },
    { header: 'Department', key: 'department', width: 18 },
    { header: 'Designation', key: 'designation', width: 20 },
    { header: 'Joined', key: 'joined', width: 9 },
    { header: 'Joined at', key: 'joinedAt', width: 18, style: { numFmt: 'dd-mmm-yyyy hh:mm AM/PM' } },
    { header: 'Clarity (1-5)', key: 'clarity', width: 12 },
    { header: 'Usefulness (1-5)', key: 'usefulness', width: 15 },
    { header: 'Trainer (1-5)', key: 'trainerRating', width: 12 },
    { header: 'Comment', key: 'comment', width: 50 },
  ];

  const totals = { held: 0, minutes: 0, seats: 0, joined: 0, reviews: [], cancelled: 0 };
  const byCategory = new Map();
  const byTrainer = new Map();
  rows.forEach((t, i) => {
    const status = liveStatus(t, now);
    const participants = (t.participants || []).filter((p) => p && visible(p._id));
    const pset = new Set(participants.map(idOf));
    const attendance = new Map((t.attendance || []).filter((a) => pset.has(idOf(a.user))).map((a) => [idOf(a.user), a]));
    const reviews = (t.feedback || []).filter((f) => visible(f.user));
    const reviewBy = new Map(reviews.map((f) => [idOf(f.user), f]));
    const sum = feedbackSummary(reviews);
    const minutes = durationMinutes(t);
    const trainer = t.trainer || personName(t.trainerUser);
    ws.addRow({
      serial: i + 1,
      title: t.title,
      category: t.category || '',
      trainer,
      trainerType: t.trainerUser ? 'Employee' : (t.trainer ? 'External' : ''),
      date: istCell(t.startDate),
      start: istCell(t.startDate),
      end: istCell(t.endDate),
      taken: hm(minutes),
      minutes: minutes ?? '',
      status: status === 'Ongoing' ? 'Live' : status === 'Planned' ? 'Upcoming' : status,
      pCount: participants.length,
      joined: attendance.size,
      reviews: sum.count,
      clarity: sum.clarity ?? '',
      usefulness: sum.usefulness ?? '',
      trainerAvg: sum.trainerRating ?? '',
      names: participants.map(personName).join(', '),
      link: t.meetingLink || '',
      files: (t.attachments || []).length || '',
      by: t.createdBy ? personName(t.createdBy) : '',
      description: t.description || '',
    });
    if (status === 'Cancelled') { totals.cancelled += 1; return; }
    totals.held += 1;
    totals.minutes += minutes || 0;
    totals.seats += participants.length;
    totals.joined += attendance.size;
    totals.reviews.push(...reviews);
    const cat = t.category || 'Uncategorised';
    const c = byCategory.get(cat) || { n: 0, minutes: 0, seats: 0 };
    byCategory.set(cat, { n: c.n + 1, minutes: c.minutes + (minutes || 0), seats: c.seats + participants.length });
    const tr = trainer || 'Not named';
    const r = byTrainer.get(tr) || { n: 0, minutes: 0, reviews: [] };
    byTrainer.set(tr, { n: r.n + 1, minutes: r.minutes + (minutes || 0), reviews: [...r.reviews, ...reviews] });

    participants.forEach((p) => {
      const prof = profiles.get(idOf(p)) || {};
      const a = attendance.get(idOf(p));
      const f = reviewBy.get(idOf(p));
      ps.addRow({
        title: t.title,
        date: istCell(t.startDate),
        taken: hm(minutes),
        trainer,
        name: personName(p),
        code: prof.employeeCode || '',
        department: prof.department || '',
        designation: prof.designation || '',
        joined: a ? 'Yes' : 'No',
        joinedAt: a ? istCell(a.firstJoinedAt) : null,
        clarity: f?.clarity ?? '',
        usefulness: f?.usefulness ?? '',
        trainerRating: f?.trainerRating ?? '',
        comment: f?.comment || '',
      });
    });
  });
  styleHead(ws);
  styleHead(ps);
  ['title', 'names', 'description'].forEach((k) => { ws.getColumn(k).alignment = { wrapText: true, vertical: 'top' }; });
  ps.getColumn('comment').alignment = { wrapText: true, vertical: 'top' };

  // ── Sheet 1 (filled now): the month in figures ──
  sm.columns = [{ key: 'k', width: 30 }, { key: 'v', width: 16 }, { key: 'w', width: 16 }, { key: 'x', width: 16 }];
  const line = (k, v = '', w = '', x = '', bold = false) => {
    const r = sm.addRow({ k, v, w, x });
    if (bold) r.font = { bold: true };
    return r;
  };
  const title = sm.addRow({ k: `Training report — ${monthLabel}` });
  title.font = { bold: true, size: 14 };
  line('Generated on', `${upperMeridiem(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }))} (IST)`);
  line('Generated by', personName(req.user));
  sm.addRow({});
  const overall = feedbackSummary(totals.reviews);
  line('Trainings held', totals.held, '', '', true);
  line('Cancelled', totals.cancelled);
  line('Total time taken', hm(totals.minutes));
  line('Seats (participants across sessions)', totals.seats);
  line('Joined from the portal', totals.joined);
  line('Reviews received', overall.count);
  line('Average clarity (1-5)', overall.clarity ?? '—');
  line('Average usefulness (1-5)', overall.usefulness ?? '—');
  line('Average trainer rating (1-5)', overall.trainerRating ?? '—');
  sm.addRow({});
  line('By category', 'Trainings', 'Time taken', 'Seats', true);
  [...byCategory.entries()].sort((a, b) => b[1].n - a[1].n)
    .forEach(([k, c]) => line(k, c.n, hm(c.minutes), c.seats));
  sm.addRow({});
  line('By trainer', 'Trainings', 'Time taken', 'Avg clarity', true);
  [...byTrainer.entries()].sort((a, b) => b[1].n - a[1].n)
    .forEach(([k, c]) => line(k, c.n, hm(c.minutes), feedbackSummary(c.reviews).clarity ?? '—'));
  sm.addRow({});
  const note = sm.addRow({ k: 'Time taken is each session\'s start to end. "Joined" counts people who opened the meeting from My Trainings while it was on.' });
  note.font = { italic: true, color: { argb: 'FF71717A' } };

  const file = `Training_${monthLabel.replace(/\s+/g, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = {
  listTrainings,
  getTraining,
  listTrainingPeople,
  createTraining,
  updateTraining,
  deleteTraining,
  createTrainingMeet,
  uploadTrainingFiles,
  deleteTrainingFile,
  downloadTrainingFile,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  myTrainings,
  joinTraining,
  submitFeedback,
  exportTrainings,
  // for services/trainingWorker
  liveStatus,
  effectiveEnd,
  whenText,
  timeText,
};
