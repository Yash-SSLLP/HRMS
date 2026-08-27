/**
 * Celebrations controller — surfaces birthdays and work anniversaries (from
 * EmployeeProfile), builds a combined month calendar (holidays, festival
 * reminders, events, celebrations, the viewer's interviews), and lets colleagues send a wish.
 *
 * A wish is delivered as an in-app NOTIFICATION and nothing else — plus a
 * celebratory email when, and only when, the sender is the Backend, the CEO or
 * the MD (see WISH_EMAIL_ROLES). It deliberately no longer opens a chat thread.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const Holiday = require('../models/Holiday');
const Event = require('../models/Event');
const Notification = require('../models/Notification');
const { enqueueMail } = require('../services/email');
const { hiddenUserIds } = require('../utils/visibility');
const { companyScopeFilter } = require('../utils/employeeScope');
const { festivalsInRange } = require('../utils/festivalFeed');
const { IST_TZ, istParts, istMonthDay, istMonthRange } = require('../utils/istDate');

// {month, day} of a date **in IST**, for recurring-date matching. Must not use
// the server's local timezone: the deployed server runs UTC, where an IST-entered
// date reads back a day early (and 1st-of-month dates fall into the previous
// month), which hid birthdays/anniversaries from the calendar. See utils/istDate.
const md = istMonthDay;

function sameMonthDay(a, b) {
  return a.m === b.m && a.d === b.d;
}

// Only these roles send a WISH BY EMAIL. Everyone else's wish is delivered
// in-app. Rationale: a birthday used to mean one email per colleague landing in
// the person's inbox — twenty people wishing you was twenty emails. The
// greeting itself is not diminished by arriving as a notification, but the
// mailbox is, so the mail is reserved for the ones that read as being "from the
// company". Deliberately NOT routed through hasPermission: every branch there
// ends in a role default, and this is a fixed list, not a grantable capability.
const WISH_EMAIL_ROLES = ['SuperAdmin', 'CEO', 'MD'];
const wishGoesByEmail = (user) => !!user && WISH_EMAIL_ROLES.includes(user.role);

// How long a wish stays on the recipient's dashboard card after the occasion.
const WISH_VISIBLE_DAYS_AFTER = 2;

/**
 * The occasion date a wish is FOR, as a UTC instant, from a recurring
 * anniversary date (birthday / joining / marriage).
 *
 * A wish can be sent days early — the widget lists a month ahead — so "two days
 * after the event" cannot be measured from when the wish was sent. This resolves
 * the occurrence the wish is actually about: this year's, rolled to next year
 * once this year's is more than the grace window in the past (which is how a
 * wish sent in December for a January birthday lands on the right date).
 *
 * Returns null when the profile has no such date on file, in which case the
 * caller falls back to counting from "now".
 * @param {Date|string|null} recurring - the stored anniversary date
 * @returns {Date|null}
 */
function occasionDateFrom(recurring) {
  if (!recurring) return null;
  const { m, d } = istMonthDay(new Date(recurring).getTime());
  const { y } = istParts(new Date());
  // IST is UTC+5:30, so an IST calendar day starts at 18:30 UTC the day before.
  const atIstMidnight = (year) => new Date(Date.UTC(year, m - 1, d) - (5.5 * 60 * 60 * 1000));
  const dayMs = 24 * 60 * 60 * 1000;
  const graceMs = WISH_VISIBLE_DAYS_AFTER * dayMs;
  const thisYear = atIstMidnight(y);
  if (thisYear.getTime() >= Date.now() - graceMs) return thisYear;

  // This year's date has already gone by. Two very different things look like
  // that, and they must not be treated alike:
  //   - an EARLY wish (December, for a January birthday) — next year's
  //     occurrence is close, and that is the occasion being wished;
  //   - a LATE wish, sent after the day passed — next year's occurrence is ~12
  //     months out, and pinning the greeting to the dashboard until then would
  //     leave it sitting there for a year.
  // The widget only lists ~2 months ahead, so anything further than that is the
  // late case: fall back to null and let the caller count from now.
  const nextYear = atIstMidnight(y + 1);
  const EARLY_WISH_WINDOW_MS = 90 * dayMs;
  return nextYear.getTime() - Date.now() <= EARLY_WISH_WINDOW_MS ? nextYear : null;
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

// Every IST calendar day from today through the end of the (months-1)th month
// after this one, as {m, d, daysAway}. `months: 2` → the rest of this month plus
// all of next month, which is what the celebrations widget asks for; a rolling
// "next 60 days" would instead stop mid-month and look arbitrary.
function nextNMonths(months) {
  const out = [];
  const now = Date.now();
  const { y: y0, m: m0 } = istParts(new Date());
  // Last day to include: end of the (months-1)th month ahead.
  const endMonth = m0 + (months - 1);
  const endYear = y0 + Math.floor((endMonth - 1) / 12);
  const endMonthNorm = ((endMonth - 1) % 12) + 1;
  const lastDay = new Date(Date.UTC(endYear, endMonthNorm, 0)).getUTCDate();

  for (let i = 0; i <= 400; i += 1) {
    const at = now + i * 24 * 60 * 60 * 1000;
    const { m, d } = istMonthDay(at);
    const { y } = istParts(new Date(at));
    out.push({ m, d, daysAway: i });
    if (y === endYear && m === endMonthNorm && d === lastDay) break;
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

async function loadActiveProfiles(req) {
  const viewer = req.user;
  // Profiles for active users who have not exited (SuperAdmin hidden from
  // others), walled into the viewer's own company — company A does not get
  // told company B's birthdays.
  const hidden = await hiddenUserIds(viewer);
  const filter = {
    $or: [{ dateOfExit: null }, { dateOfExit: { $exists: false } }],
    ...companyScopeFilter(req),
  };
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
  const profiles = await loadActiveProfiles(req);
  const t = md(new Date());
  const currentYear = istParts(new Date()).y;

  const birthdays = [];
  const anniversaries = [];
  const marriages = [];

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
    if (p.dateOfMarriage) {
      const years = currentYear - istParts(p.dateOfMarriage).y;
      if (years >= 1 && sameMonthDay(md(p.dateOfMarriage), t)) {
        marriages.push({ ...personPayload(p), date: p.dateOfMarriage, years });
      }
    }
  }

  res.json({
    today: new Date().toISOString().slice(0, 10),
    birthdays,
    anniversaries,
    marriages,
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
  // Two windows: `days` (rolling, the original contract) or `months` (calendar,
  // e.g. months=2 → the rest of this month plus all of next). `months` wins when
  // both are sent.
  const months = req.query.months ? Math.min(Math.max(Number(req.query.months) || 1, 1), 6) : null;
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
  const profiles = await loadActiveProfiles(req);
  const range = months ? nextNMonths(months) : nextNDays(days);
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
    if (p.dateOfMarriage) {
      const x = md(p.dateOfMarriage);
      const hit = range.find((r) => sameMonthDay(x, r));
      // Same >= 1 year rule as the work anniversary: the wedding day itself is
      // not an anniversary.
      const years = currentYear - istParts(p.dateOfMarriage).y;
      if (hit && years >= 1) {
        events.push({
          type: 'marriage',
          daysAway: hit.daysAway,
          date: p.dateOfMarriage,
          years,
          ...personPayload(p),
        });
      }
    }
  }

  events.sort((a, b) => a.daysAway - b.daysAway);
  res.json({ days: months ? null : days, months, count: events.length, events });
});

/**
 * Build a combined calendar for a month: holidays, custom events, recurring
 * birthdays/anniversaries, and interviews the viewer is assigned to take.
 * @route GET /api/celebrations/calendar?month=YYYY-MM
 * @param {string} [req.query.month] - YYYY-MM, defaults to the current month
 * @returns {{year, month, count, events: Object[]}} each {day, type, label, meta}, sorted by day
 */
// GET /api/celebrations/calendar?month=YYYY-MM
// Returns every event (holiday / birthday / work + wedding anniversary) in the given
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

  // --- Festival reminders (Holi, Diwali, Rakhi …) for the exact month/year ---
  // Reminder only — these never mark a non-working day. One that shares its day
  // with a company holiday is dropped inside festivalsInRange, so the calendar
  // never shows both chips for the same occasion.
  const festivals = await festivalsInRange(monthStart, monthEnd);
  for (const f of festivals) {
    events.push({
      day: istParts(f.date).d,
      type: 'festival',
      label: f.name,
      meta: { emoji: f.emoji, description: f.description, greeting: f.greeting },
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
  const profiles = await loadActiveProfiles(req);
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
    if (p.dateOfMarriage) {
      const wed = istParts(p.dateOfMarriage);
      const years = year - wed.y;
      if (wed.m === month && years >= 1) {
        events.push({
          day: wed.d,
          type: 'marriage',
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
 * @param {string} [req.body.type='birthday'] - 'birthday' | 'anniversary' | 'marriage'
 * @param {string} [req.body.message] - custom note, truncated to 280 chars
 * @returns {{ok: boolean}} (201); 400 if wishing yourself
 * @sideeffect creates a notification; enqueues an email only for WISH_EMAIL_ROLES senders
 */
// POST /api/celebrations/wish
// Send a birthday / work-anniversary greeting to a colleague. Creates an in-app
// notification for the recipient; a celebratory email goes out only when the
// sender is a SuperAdmin / CEO / MD. Body:
//   { employeeId, type: 'birthday' | 'anniversary', message? }
const sendWish = asyncHandler(async (req, res) => {
  const { employeeId, type = 'birthday', message } = req.body || {};
  if (!employeeId) {
    res.status(400);
    throw new Error('employeeId is required');
  }
  const kind = ['anniversary', 'marriage'].includes(type) ? type : 'birthday';

  const profile = await EmployeeProfile.findById(employeeId)
    // The three recurring dates drive the wish's expiry — see occasionDateFrom.
    .select('user dateOfBirth dateOfJoining dateOfMarriage hrPartner company')
    .populate({ path: 'user', select: 'firstName lastName email isActive' });
  if (!profile || !profile.user) {
    res.status(404);
    throw new Error('Recipient not found');
  }
  // Company wall: you can only wish the colleagues you can see.
  const { companyOutOfScope } = require('../utils/employeeScope');
  if (companyOutOfScope(req, profile)) {
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

  const OCCASIONS = {
    birthday: { label: 'Birthday', emoji: '🎂', line: `Happy birthday, ${toFirst}! Wishing you a wonderful day. 🎂` },
    anniversary: { label: 'Work Anniversary', emoji: '🎊', line: `Happy work anniversary, ${toFirst}! Thank you for everything you do. 🎊` },
    marriage: { label: 'Wedding Anniversary', emoji: '💍', line: `Happy wedding anniversary, ${toFirst}! Wishing you both many more happy years. 💍` },
  };
  const occasion = OCCASIONS[kind].label;
  const emoji = OCCASIONS[kind].emoji;
  const defaultLine = OCCASIONS[kind].line;
  const wishLine = clean || defaultLine;

  // The wish leaves the dashboard card two days after the occasion itself, not
  // two days after it was sent — wishes arrive early. Falls back to counting
  // from now when the profile has no date on file for this occasion.
  const RECURRING = {
    birthday: profile.dateOfBirth,
    anniversary: profile.dateOfJoining,
    marriage: profile.dateOfMarriage,
  };
  const occasionAt = occasionDateFrom(RECURRING[kind]) || new Date();
  const expiresAt = new Date(occasionAt.getTime() + WISH_VISIBLE_DAYS_AFTER * 24 * 60 * 60 * 1000);

  await Notification.create({
    recipient: profile.user._id,
    type: 'celebration',
    title: `${emoji} ${fromName} sent you a ${occasion.toLowerCase()} wish`,
    body: wishLine,
    expiresAt,
  });

  // NO CHAT MESSAGE. A wish used to also open a chat thread with the sender,
  // auto-creating an accepted Connection between two people who had never
  // spoken so the message had somewhere to land. On a birthday that meant a
  // colleague's greeting arrived three times over — notification, chat thread,
  // email — and left behind a chat connection nobody asked for. The
  // notification above is the whole in-app delivery now; only the email below
  // is added on top, and only for the roles that speak for the company.

  // EMAIL IS THE EXCEPTION, NOT THE RULE. A colleague's wish is delivered as
  // the in-app notification above and stops there; only a wish from the
  // Backend, the CEO or the MD also reaches the inbox. See WISH_EMAIL_ROLES.
  const emailed = wishGoesByEmail(req.user);
  if (emailed) {
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
  }

  // `emailed` lets the client say what actually happened instead of implying
  // every wish reaches the inbox.
  res.status(201).json({ ok: true, emailed });
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
  const wishes = await Notification.find({
    recipient: req.user._id,
    type: 'celebration',
    // Dismissed by the recipient — gone from the card, kept in the bell feed.
    dismissedAt: null,
    // Still within two days of the occasion. `$exists: false` keeps wishes sent
    // before this field existed visible rather than making them all vanish on
    // deploy; they age out of the `limit` on their own.
    $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('title body createdAt readAt expiresAt')
    .lean();
  res.json({ count: wishes.length, wishes });
});

/**
 * Dismiss one received wish from the dashboard card.
 * @route PATCH /api/celebrations/wishes/:id/dismiss
 * @param {string} req.params.id - the celebration notification's id
 * @returns {{id: string, dismissed: boolean}}; 404 if it is not the caller's
 * @sideeffect stamps dismissedAt; the notification itself is NOT deleted, so it
 *   remains in the bell feed — this only clears the dashboard card.
 */
// PATCH /api/celebrations/wishes/:id/dismiss
const dismissWish = asyncHandler(async (req, res) => {
  // Scoped to the caller AND to celebration notifications: a user must not be
  // able to dismiss somebody else's item, nor use this to quietly clear an
  // approval or payslip notification that is not a wish.
  const wish = await Notification.findOne({
    _id: req.params.id,
    recipient: req.user._id,
    type: 'celebration',
  });
  if (!wish) {
    res.status(404);
    throw new Error('Wish not found');
  }
  if (!wish.dismissedAt) {
    wish.dismissedAt = new Date();
    await wish.save();
  }
  res.json({ id: wish._id, dismissed: true });
});

module.exports = {
  todayCelebrations, upcomingCelebrations, monthCalendar, sendWish, receivedWishes, dismissWish,
};
