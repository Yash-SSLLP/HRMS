/**
 * Celebrations controller — surfaces birthdays and work anniversaries (from
 * EmployeeProfile), builds a combined month calendar (holidays, events,
 * celebrations, the viewer's interviews), and lets colleagues send a wish that
 * fans out as an in-app notification, a chat message, and a celebratory email.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Holiday = require('../models/Holiday');
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const Connection = require('../models/Connection');
const Message = require('../models/Message');
const { enqueueMail } = require('../services/email');
const { hiddenUserIds } = require('../utils/visibility');
const { IST_TZ, istParts, istMonthDay, istMonthRange } = require('../utils/istDate');

// {month, day} of a date **in IST**, for recurring-date matching. Must not use
// the server's local timezone: the deployed server runs UTC, where an IST-entered
// date reads back a day early (and 1st-of-month dates fall into the previous
// month), which hid birthdays/anniversaries from the calendar. See utils/istDate.
const md = istMonthDay;

function sameMonthDay(a, b) {
  return a.m === b.m && a.d === b.d;
}

// The next `n` IST calendar days, as {m, d, daysAway}.
function nextNDays(n) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i <= n; i++) {
    const { m, d } = istMonthDay(now + i * 24 * 60 * 60 * 1000);
    out.push({ m, d, daysAway: i });
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

/**
 * List today's birthdays and (>=1yr) work anniversaries among active employees.
 * @route GET /api/celebrations/today
 * @returns {{today: string, birthdays: Object[], anniversaries: Object[]}}
 */
// GET /api/celebrations/today
const todayCelebrations = asyncHandler(async (req, res) => {
  const profiles = await loadActiveProfiles(req.user);
  const t = md(new Date());
  const currentYear = istParts(new Date()).y;

  const birthdays = [];
  const anniversaries = [];

  for (const p of profiles) {
    if (p.dateOfBirth && sameMonthDay(md(p.dateOfBirth), t)) {
      birthdays.push({ ...personPayload(p), date: p.dateOfBirth });
    }
    if (p.dateOfJoining) {
      const years = currentYear - istParts(p.dateOfJoining).y;
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

/**
 * List upcoming birthdays/anniversaries within the next N days (1-30, default 7).
 * @route GET /api/celebrations/upcoming?days=7
 * @param {number} [req.query.days] - clamped to 1-30
 * @returns {{days: number, count: number, events: Object[]}} sorted by daysAway
 */
// GET /api/celebrations/upcoming?days=7
const upcomingCelebrations = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
  const profiles = await loadActiveProfiles(req.user);
  const range = nextNDays(days);
  const currentYear = istParts(new Date()).y;

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
      const years = currentYear - istParts(p.dateOfJoining).y;
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

/**
 * Build a combined calendar for a month: holidays, custom events, recurring
 * birthdays/anniversaries, and interviews the viewer is assigned to take.
 * @route GET /api/celebrations/calendar?month=YYYY-MM
 * @param {string} [req.query.month] - YYYY-MM, defaults to the current month
 * @returns {{year, month, count, events: Object[]}} each {day, type, label, meta}, sorted by day
 */
// GET /api/celebrations/calendar?month=YYYY-MM
// Returns every event (holiday / birthday / anniversary) falling in the given
// month, each normalized to { day, type, label, meta }. Birthdays & anniversaries
// match on month+day in any year; holidays match the exact month.
const monthCalendar = asyncHandler(async (req, res) => {
  const nowIst = istParts(new Date());
  let year = nowIst.y;
  let month = nowIst.m; // 1-12

  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
    const [y, m] = req.query.month.split('-').map(Number);
    if (m >= 1 && m <= 12) {
      year = y;
      month = m;
    }
  }

  const events = [];
  // Every dated query below is bounded by the IST month, and every entry is
  // placed on its IST calendar day, so the grid matches what people see on a
  // wall calendar in India no matter where the server runs.
  const [monthStart, monthEnd] = istMonthRange(year, month);

  // --- Holidays for the exact month/year ---
  const holidays = await Holiday.find({
    date: { $gte: monthStart, $lt: monthEnd },
  }).sort({ date: 1 });
  for (const h of holidays) {
    events.push({
      day: istParts(h.date).d,
      type: 'holiday',
      label: h.name,
      meta: { holidayType: h.type, description: h.description },
    });
  }

  // --- Events for the exact month/year ---
  const customEvents = await Event.find({
    date: { $gte: monthStart, $lt: monthEnd },
  }).sort({ date: 1 });
  for (const ev of customEvents) {
    events.push({
      day: istParts(ev.date).d,
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
      const joined = istParts(p.dateOfJoining);
      const years = year - joined.y;
      if (joined.m === month && years >= 1) {
        events.push({
          day: joined.d,
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
  const interviewCands = await Candidate.find({ 'rounds.interviewer': req.user._id })
    .populate('job', 'title')
    .select('name job rounds resumeName resumePath');
  for (const c of interviewCands) {
    for (const r of c.rounds || []) {
      if (!r.scheduledAt || String(r.interviewer) !== String(req.user._id)) continue;
      // Place the interview on its IST calendar day (scheduledAt is stored UTC).
      const at = istParts(r.scheduledAt);
      if (at.y !== year || at.m !== month) continue;
      events.push({
        day: at.d,
        type: 'interview',
        label: `${c.name} · ${r.label}`,
        meta: {
          time: new Date(r.scheduledAt).toLocaleTimeString('en-IN', {
            hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST_TZ,
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

  // --- Reminders visible to the viewer ---
  // Their own reminders plus any aimed at them by HR/Admin/CEO (directly, via
  // their department, or company-wide). `reminder` = personal, `hrReminder` =
  // pushed to them by someone else, so the calendar can colour them apart.
  const Reminder = require('../models/Reminder');
  const { myDepartment } = require('./reminderController');
  const reminders = await Reminder.find({
    ...Reminder.visibleFilter(req.user, await myDepartment(req.user)),
    date: { $gte: monthStart, $lt: monthEnd },
  })
    .populate('createdBy', 'firstName lastName role')
    .sort({ date: 1 });
  for (const r of reminders) {
    const mine = String(r.createdBy?._id || r.createdBy) === String(req.user._id);
    const setByName = `${r.createdBy?.firstName || ''} ${r.createdBy?.lastName || ''}`.trim();
    events.push({
      day: istParts(r.date).d,
      type: mine ? 'reminder' : 'hrReminder',
      label: r.title,
      meta: {
        reminderId: String(r._id),
        time: r.time || '',
        notes: r.notes || '',
        priority: r.priority,
        scope: r.scope,
        department: r.department || '',
        // Only the creator can edit, so only they need the audience ids (the
        // edit form pre-selects them).
        recipientIds: mine ? (r.recipients || []).map(String) : [],
        setBy: mine ? 'You' : (setByName || 'HR'),
        setByRole: r.createdByRole || r.createdBy?.role || '',
        canEdit: mine || req.user.role === 'SuperAdmin',
      },
    });
  }

  // --- Task deadlines (assigned to, or created by, the viewer) ---
  const Task = require('../models/Task');
  const tasks = await Task.find({
    $or: [{ assignedTo: req.user._id }, { createdBy: req.user._id }],
    dueDate: { $gte: monthStart, $lt: monthEnd },
  })
    .populate('project', 'name')
    .populate('assignedTo', 'firstName lastName')
    .sort({ dueDate: 1 });
  for (const t of tasks) {
    const assignee = `${t.assignedTo?.firstName || ''} ${t.assignedTo?.lastName || ''}`.trim();
    events.push({
      day: istParts(t.dueDate).d,
      type: 'task',
      label: t.title,
      meta: {
        taskId: String(t._id),
        status: t.status,
        priority: t.priority,
        project: t.project?.name || '',
        assignedTo: String(t.assignedTo?._id || t.assignedTo || '') === String(req.user._id)
          ? 'You'
          : (assignee || '—'),
        done: t.status === 'Done',
      },
    });
  }

  events.sort((a, b) => a.day - b.day);
  res.json({ year, month, count: events.length, events });
});

/**
 * Send a birthday/anniversary wish to a colleague.
 * @route POST /api/celebrations/wish
 * @param {string} req.body.employeeId - recipient's profile id (required)
 * @param {string} [req.body.type='birthday'] - 'birthday' or 'anniversary'
 * @param {string} [req.body.message] - custom note, truncated to 280 chars
 * @returns {{ok: boolean}} (201); 400 if wishing yourself
 * @sideeffect creates a notification, posts a chat message (auto-connecting), and enqueues an email
 */
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
    text: `Hi ${toFirst},\n\n${wishLine}\n\n- ${fromName}`,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <div style="font-size:40px;text-align:center;">${emoji}</div>
        <h2 style="text-align:center;color:#111827;margin:8px 0 16px;">${occasion} Wishes!</h2>
        <p style="color:#374151;font-size:15px;line-height:1.6;">Hi ${toFirst},</p>
        <p style="color:#374151;font-size:15px;line-height:1.6;">${wishLine}</p>
        <p style="color:#6b7280;font-size:14px;margin-top:20px;">- ${fromName}</p>
      </div>`,
  });

  res.status(201).json({ ok: true });
});

/**
 * List celebration wishes the caller has received (drives the dashboard card).
 * @route GET /api/celebrations/wishes/received?limit=
 * @param {number} [req.query.limit] - max rows, capped at 50 (default 10)
 * @returns {{count: number, wishes: Object[]}}
 */
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
