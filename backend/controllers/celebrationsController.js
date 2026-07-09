const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Holiday = require('../models/Holiday');
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const Connection = require('../models/Connection');
const Message = require('../models/Message');
const { enqueueMail } = require('../services/email');
const { hiddenUserIds } = require('../utils/visibility');

function md(date) {
  const d = new Date(date);
  return { m: d.getMonth() + 1, d: d.getDate() };
}

function sameMonthDay(a, b) {
  return a.m === b.m && a.d === b.d;
}

function nextNDays(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i <= n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    out.push({ m: d.getMonth() + 1, d: d.getDate(), daysAway: i });
  }
  return out;
}

function personPayload(p) {
  return {
    employeeId: p._id,
    employeeCode: p.employeeCode,
    firstName: p.user?.firstName,
    lastName: p.user?.lastName,
    fullName: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim(),
    designation: p.designation,
    department: p.department,
  };
}

async function loadActiveProfiles(viewer) {
  // Profiles for active users who have not exited (SuperAdmin hidden from others).
  const hidden = await hiddenUserIds(viewer);
  const filter = { $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }] };
  if (hidden.length) filter.user = { $nin: hidden };
  const profiles = await EmployeeProfile.find(filter)
    .populate({ path: 'user', select: 'firstName lastName email isActive' });
  return profiles.filter((p) => p.user && p.user.isActive !== false);
}

// GET /api/celebrations/today
const todayCelebrations = asyncHandler(async (req, res) => {
  const profiles = await loadActiveProfiles(req.user);
  const t = md(new Date());
  const currentYear = new Date().getFullYear();

  const birthdays = [];
  const anniversaries = [];

  for (const p of profiles) {
    if (p.dateOfBirth && sameMonthDay(md(p.dateOfBirth), t)) {
      birthdays.push({ ...personPayload(p), date: p.dateOfBirth });
    }
    if (p.dateOfJoining) {
      const years = currentYear - new Date(p.dateOfJoining).getFullYear();
      if (years >= 1 && sameMonthDay(md(p.dateOfJoining), t)) {
        anniversaries.push({ ...personPayload(p), date: p.dateOfJoining, years });
      }
    }
  }

  res.json({
    today: new Date().toISOString().slice(0, 10),
    birthdays,
    anniversaries,
  });
});

// GET /api/celebrations/upcoming?days=7
const upcomingCelebrations = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
  const profiles = await loadActiveProfiles(req.user);
  const range = nextNDays(days);
  const currentYear = new Date().getFullYear();

  const events = [];

  for (const p of profiles) {
    if (p.dateOfBirth) {
      const x = md(p.dateOfBirth);
      const hit = range.find((r) => sameMonthDay(x, r));
      if (hit) {
        events.push({
          type: 'birthday',
          daysAway: hit.daysAway,
          date: p.dateOfBirth,
          ...personPayload(p),
        });
      }
    }
    if (p.dateOfJoining) {
      const x = md(p.dateOfJoining);
      const hit = range.find((r) => sameMonthDay(x, r));
      const years = currentYear - new Date(p.dateOfJoining).getFullYear();
      if (hit && years >= 1) {
        events.push({
          type: 'anniversary',
          daysAway: hit.daysAway,
          date: p.dateOfJoining,
          years,
          ...personPayload(p),
        });
      }
    }
  }

  events.sort((a, b) => a.daysAway - b.daysAway);
  res.json({ days, count: events.length, events });
});

// GET /api/celebrations/calendar?month=YYYY-MM
// Returns every event (holiday / birthday / anniversary) falling in the given
// month, each normalized to { day, type, label, meta }. Birthdays & anniversaries
// match on month+day in any year; holidays match the exact month.
const monthCalendar = asyncHandler(async (req, res) => {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-12

  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    const [y, m] = req.query.month.split('-').map(Number);
    if (m >= 1 && m <= 12) {
      year = y;
      month = m;
    }
  }

  const events = [];

  // --- Holidays for the exact month/year ---
  const holidays = await Holiday.find({
    date: { $gte: new Date(year, month - 1, 1), $lt: new Date(year, month, 1) },
  }).sort({ date: 1 });
  for (const h of holidays) {
    events.push({
      day: new Date(h.date).getDate(),
      type: 'holiday',
      label: h.name,
      meta: { holidayType: h.type, description: h.description },
    });
  }

  // --- Events for the exact month/year ---
  const customEvents = await Event.find({
    date: { $gte: new Date(year, month - 1, 1), $lt: new Date(year, month, 1) },
  }).sort({ date: 1 });
  for (const ev of customEvents) {
    events.push({
      day: new Date(ev.date).getDate(),
      type: 'event',
      label: ev.title,
      meta: { time: ev.time, location: ev.location, description: ev.description },
    });
  }

  // --- Birthdays & anniversaries (recurring month/day) ---
  const profiles = await loadActiveProfiles(req.user);
  for (const p of profiles) {
    if (p.dateOfBirth) {
      const x = md(p.dateOfBirth);
      if (x.m === month) {
        events.push({
          day: x.d,
          type: 'birthday',
          label: personPayload(p).fullName,
          meta: personPayload(p),
        });
      }
    }
    if (p.dateOfJoining) {
      const x = md(p.dateOfJoining);
      const years = year - new Date(p.dateOfJoining).getFullYear();
      if (x.m === month && years >= 1) {
        events.push({
          day: x.d,
          type: 'anniversary',
          label: `${personPayload(p).fullName} (${years} yr)`,
          meta: { ...personPayload(p), years },
        });
      }
    }
  }

  // --- Interviews the viewer is assigned to take (their own calendar) ---
  // Interviews reference the interviewer as a User; the viewer is req.user.
  const Candidate = require('../models/Candidate');
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // IST is a fixed UTC+5:30
  const interviewCands = await Candidate.find({ 'rounds.interviewer': req.user._id })
    .populate('job', 'title')
    .select('name job rounds resumeName resumePath');
  for (const c of interviewCands) {
    for (const r of c.rounds || []) {
      if (!r.scheduledAt || String(r.interviewer) !== String(req.user._id)) continue;
      // Place the interview on its IST calendar day (scheduledAt is stored UTC).
      const ist = new Date(new Date(r.scheduledAt).getTime() + IST_OFFSET_MS);
      if (ist.getUTCFullYear() !== year || ist.getUTCMonth() + 1 !== month) continue;
      events.push({
        day: ist.getUTCDate(),
        type: 'interview',
        label: `${c.name} · ${r.label}`,
        meta: {
          time: new Date(r.scheduledAt).toLocaleTimeString('en-IN', {
            hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
          }),
          candidateId: String(c._id),
          candidateName: c.name,
          round: r.label,
          status: r.status,
          durationMinutes: r.meetDurationMinutes || null,
          jobTitle: c.job?.title || '',
          hasResume: !!(c.resumeName || c.resumePath),
          meetingLink: r.meetingLink || '',
        },
      });
    }
  }

  events.sort((a, b) => a.day - b.day);
  res.json({ year, month, count: events.length, events });
});

// POST /api/celebrations/wish
// Send a birthday / work-anniversary greeting to a colleague. Creates an in-app
// notification for the recipient and enqueues a celebratory email. Body:
//   { employeeId, type: 'birthday' | 'anniversary', message? }
const sendWish = asyncHandler(async (req, res) => {
  const { employeeId, type = 'birthday', message } = req.body || {};
  if (!employeeId) {
    res.status(400);
    throw new Error('employeeId is required');
  }
  const kind = type === 'anniversary' ? 'anniversary' : 'birthday';

  const profile = await EmployeeProfile.findById(employeeId).populate({
    path: 'user',
    select: 'firstName lastName email isActive',
  });
  if (!profile || !profile.user) {
    res.status(404);
    throw new Error('Recipient not found');
  }

  // Don't let someone wish themselves.
  if (String(profile.user._id) === String(req.user._id)) {
    res.status(400);
    throw new Error('You cannot send a wish to yourself');
  }

  const fromName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A colleague';
  const toFirst = profile.user.firstName || 'there';
  const clean = (message || '').toString().trim().slice(0, 280);

  const occasion = kind === 'anniversary' ? 'Work Anniversary' : 'Birthday';
  const emoji = kind === 'anniversary' ? '🎊' : '🎂';
  const defaultLine =
    kind === 'anniversary'
      ? `Happy work anniversary, ${toFirst}! Thank you for everything you do. 🎊`
      : `Happy birthday, ${toFirst}! Wishing you a wonderful day. 🎂`;
  const wishLine = clean || defaultLine;

  await Notification.create({
    recipient: profile.user._id,
    type: 'celebration',
    title: `${emoji} ${fromName} sent you a ${occasion.toLowerCase()} wish`,
    body: wishLine,
  });

  // Also drop the wish into the recipient's chat, from the sender. Ensure an
  // accepted connection exists between the two so the message has a thread.
  // Best-effort — never let a chat hiccup block the wish/email.
  try {
    const pairKey = Connection.buildPairKey(req.user._id, profile.user._id);
    let conn = await Connection.findOne({ pairKey });
    if (!conn) {
      conn = await Connection.create({ requester: req.user._id, recipient: profile.user._id, status: 'accepted' });
    } else if (conn.status !== 'accepted') {
      conn.status = 'accepted';
      await conn.save();
    }
    await Message.create({ connection: conn._id, sender: req.user._id, body: `${emoji} ${wishLine}` });
  } catch (err) {
    console.error('Wish chat delivery failed:', err.message);
  }

  await enqueueMail({
    to: profile.user.email,
    subject: `${emoji} ${occasion} wishes from ${fromName}`,
    text: `Hi ${toFirst},\n\n${wishLine}\n\n— ${fromName}`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <div style="font-size:40px;text-align:center;">${emoji}</div>
        <h2 style="text-align:center;color:#111827;margin:8px 0 16px;">${occasion} Wishes!</h2>
        <p style="color:#374151;font-size:15px;line-height:1.6;">Hi ${toFirst},</p>
        <p style="color:#374151;font-size:15px;line-height:1.6;">${wishLine}</p>
        <p style="color:#6b7280;font-size:14px;margin-top:20px;">— ${fromName}</p>
      </div>`,
  });

  res.status(201).json({ ok: true });
});

// GET /api/celebrations/wishes/received — recent birthday/anniversary wishes
// received by the current user (drives the dashboard "Wishes for you" card).
const receivedWishes = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const wishes = await Notification.find({ recipient: req.user._id, type: 'celebration' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('title body createdAt readAt')
    .lean();
  res.json({ count: wishes.length, wishes });
});

module.exports = { todayCelebrations, upcomingCelebrations, monthCalendar, sendWish, receivedWishes };
