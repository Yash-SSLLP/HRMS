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
const User = require('../models/User');
const Company = require('../models/Company');
const { enqueueMail } = require('../services/email');
const { hiddenUserIds, EXECUTIVE_ROLES } = require('../utils/visibility');
const { companyScopeFilter, viewerCompanyScope } = require('../utils/employeeScope');
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
    // Also the user id: the admin dashboard renders the widget with no profile
    // id to compare against, so "that's you" needs an identity that every
    // viewer has. Execs are matched the same way (execPayload).
    userId: p.user?._id,
    employeeCode: p.employeeCode,
    firstName: p.user?.firstName,
    lastName: p.user?.lastName,
    fullName: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim(),
    designation: p.designation,
    department: p.department,
  };
}

/**
 * The executive (CEO/MD) accounts whose celebrations this viewer should see.
 *
 * Execs are not employees — they carry no EmployeeProfile at all — so the
 * profile sweep below can never find them, and their birthday used to be the
 * one the calendar never showed. Their dates live on the User document
 * instead (see models/User.js), set by the Backend on the Users page.
 *
 * Company wall, mirroring `User.companies` semantics used everywhere else:
 * an exec with no companies assigned is company-agnostic and therefore
 * everybody's exec; a narrowed exec is shown only to viewers whose own scope
 * includes one of their companies. An unrestricted viewer sees all of them.
 * @param {import('express').Request} req
 * @returns {Promise<Object[]>} User docs with at least one celebration date
 */
async function loadCelebrationExecs(req) {
  const execs = await User.find({
    role: { $in: EXECUTIVE_ROLES },
    isActive: { $ne: false },
    $or: [
      { dateOfBirth: { $ne: null } },
      { dateOfJoining: { $ne: null } },
      { dateOfMarriage: { $ne: null } },
    ],
  }).select('firstName lastName email role companies dateOfBirth dateOfJoining dateOfMarriage');

  const scope = viewerCompanyScope(req);
  if (!scope) return execs; // Backend, or an account with no company of its own
  return execs.filter((u) => {
    const theirs = (Array.isArray(u.companies) ? u.companies : []).filter(Boolean).map(String);
    if (!theirs.length) return true; // unnarrowed exec — belongs to every company
    return theirs.some((id) => scope.ids.includes(id));
  });
}

/** Celebration payload for an exec, shaped like personPayload so clients need no branch. */
function execPayload(u) {
  return {
    employeeId: null, // execs have no EmployeeProfile — wishes address userId
    userId: u._id,
    employeeCode: null,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
    designation: u.role, // "CEO" / "MD" — what they are, where a title would go
    department: '',
    isExecutive: true,
  };
}

/**
 * The companies whose foundation day this viewer should see — their own.
 *
 * Same wall as everywhere else: a walled viewer gets only the companies they
 * are in, an unrestricted one (the Backend, an unnarrowed exec, an account with
 * no company) gets all of them. Companies with no `foundedOn` are skipped, so
 * the feature is invisible until somebody sets a date.
 * @param {import('express').Request} req
 * @returns {Promise<Object[]>}
 */
async function loadCelebrationCompanies(req) {
  const scope = viewerCompanyScope(req);
  const filter = { foundedOn: { $ne: null }, isActive: { $ne: false } };
  if (scope) filter._id = { $in: scope.ids };
  return Company.find(filter).select('name code foundedOn').lean();
}

/** Celebration payload for a company anniversary. */
function companyPayload(c, years) {
  return {
    employeeId: null,
    companyId: c._id,
    fullName: c.name, // clients render `fullName` as the headline
    companyName: c.name,
    employeeCode: c.code || null,
    designation: 'Foundation day',
    department: '',
    years,
    isCompany: true,
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

  // Executives (no profile, dates on the User doc) join the same three lists —
  // a CEO's birthday is a birthday.
  for (const u of await loadCelebrationExecs(req)) {
    if (u.dateOfBirth && sameMonthDay(md(u.dateOfBirth), t)) {
      birthdays.push({ ...execPayload(u), date: u.dateOfBirth });
    }
    if (u.dateOfJoining) {
      const years = currentYear - istParts(u.dateOfJoining).y;
      if (years >= 1 && sameMonthDay(md(u.dateOfJoining), t)) {
        anniversaries.push({ ...execPayload(u), date: u.dateOfJoining, years });
      }
    }
    if (u.dateOfMarriage) {
      const years = currentYear - istParts(u.dateOfMarriage).y;
      if (years >= 1 && sameMonthDay(md(u.dateOfMarriage), t)) {
        marriages.push({ ...execPayload(u), date: u.dateOfMarriage, years });
      }
    }
  }

  // The company's own anniversary — everyone in it celebrates the same day.
  const companies = [];
  for (const c of await loadCelebrationCompanies(req)) {
    if (!sameMonthDay(md(c.foundedOn), t)) continue;
    const years = currentYear - istParts(c.foundedOn).y;
    if (years >= 1) companies.push({ ...companyPayload(c, years), date: c.foundedOn });
  }

  res.json({
    today: new Date().toISOString().slice(0, 10),
    birthdays,
    anniversaries,
    marriages,
    companies,
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

  // Executives, from their User dates (they have no profile to sweep).
  for (const u of await loadCelebrationExecs(req)) {
    const EXEC_DATES = [
      { type: 'birthday', date: u.dateOfBirth, needsYears: false },
      { type: 'anniversary', date: u.dateOfJoining, needsYears: true },
      { type: 'marriage', date: u.dateOfMarriage, needsYears: true },
    ];
    for (const d of EXEC_DATES) {
      if (!d.date) continue;
      const hit = range.find((r) => sameMonthDay(md(d.date), r));
      if (!hit) continue;
      const years = currentYear - istParts(d.date).y;
      if (d.needsYears && years < 1) continue;
      events.push({
        type: d.type,
        daysAway: hit.daysAway,
        date: d.date,
        ...(d.needsYears ? { years } : {}),
        ...execPayload(u),
      });
    }
  }

  // The company's foundation day, for every company this viewer belongs to.
  for (const c of await loadCelebrationCompanies(req)) {
    const hit = range.find((r) => sameMonthDay(md(c.foundedOn), r));
    if (!hit) continue;
    const years = currentYear - istParts(c.foundedOn).y;
    if (years < 1) continue; // the founding day itself is not an anniversary
    events.push({
      type: 'company',
      daysAway: hit.daysAway,
      date: c.foundedOn,
      ...companyPayload(c, years),
    });
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

  // --- Executive (CEO/MD) birthdays & anniversaries ---
  // Same three chips as an employee's, from the User document, because an exec
  // has no EmployeeProfile for the loop above to find.
  for (const u of await loadCelebrationExecs(req)) {
    if (u.dateOfBirth) {
      const x = md(u.dateOfBirth);
      if (x.m === month) {
        events.push({ day: x.d, type: 'birthday', label: execPayload(u).fullName, meta: execPayload(u) });
      }
    }
    if (u.dateOfJoining) {
      const joined = istParts(u.dateOfJoining);
      const years = year - joined.y;
      if (joined.m === month && years >= 1) {
        events.push({
          day: joined.d,
          type: 'anniversary',
          label: `${execPayload(u).fullName} (${years} yr)`,
          meta: { ...execPayload(u), years },
        });
      }
    }
    if (u.dateOfMarriage) {
      const wed = istParts(u.dateOfMarriage);
      const years = year - wed.y;
      if (wed.m === month && years >= 1) {
        events.push({
          day: wed.d,
          type: 'marriage',
          label: `${execPayload(u).fullName} (${years} yr)`,
          meta: { ...execPayload(u), years },
        });
      }
    }
  }

  // --- Company foundation day (recurring, everyone in that company) ---
  for (const c of await loadCelebrationCompanies(req)) {
    const founded = istParts(c.foundedOn);
    const years = year - founded.y;
    if (founded.m !== month || years < 1) continue;
    events.push({
      day: founded.d,
      type: 'company',
      label: `${c.name} (${years} yr)`,
      meta: companyPayload(c, years),
    });
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
 * @param {string} [req.body.employeeId] - recipient's profile id (staff)
 * @param {string} [req.body.userId] - recipient's user id (CEO/MD, who have no profile)
 * @param {string} [req.body.type='birthday'] - 'birthday' | 'anniversary' | 'marriage'
 * @param {string} [req.body.message] - custom note, truncated to 280 chars
 * @returns {{ok: boolean}} (201); 400 if wishing yourself
 * @sideeffect creates a notification; enqueues an email only for WISH_EMAIL_ROLES senders
 */
// POST /api/celebrations/wish
// Send a birthday / work-anniversary greeting to a colleague. Creates an in-app
// notification for the recipient; a celebratory email goes out only when the
// sender is a SuperAdmin / CEO / MD. Body:
//   { employeeId | userId, type: 'birthday' | 'anniversary', message? }
const sendWish = asyncHandler(async (req, res) => {
  const { employeeId, userId, type = 'birthday', message } = req.body || {};
  if (!employeeId && !userId) {
    res.status(400);
    throw new Error('employeeId or userId is required');
  }
  const kind = ['anniversary', 'marriage'].includes(type) ? type : 'birthday';

  // TWO KINDS OF RECIPIENT. Staff are addressed by profile id and their dates
  // live on the profile; an exec (CEO/MD) has no profile at all, so the widget
  // sends their user id and the dates come off the User document. Everything
  // downstream works off `recipient`, which is the same shape either way.
  let recipient = null;
  if (employeeId) {
    const profile = await EmployeeProfile.findById(employeeId)
      // The three recurring dates drive the wish's expiry — see occasionDateFrom.
      .select('user dateOfBirth dateOfJoining dateOfMarriage hrPartner company')
      .populate({ path: 'user', select: 'firstName lastName email isActive' });
    // Company wall: you can only wish the colleagues you can see.
    const { companyOutOfScope } = require('../utils/employeeScope');
    if (profile && profile.user && !companyOutOfScope(req, profile)) {
      recipient = {
        user: profile.user,
        dates: {
          birthday: profile.dateOfBirth,
          anniversary: profile.dateOfJoining,
          marriage: profile.dateOfMarriage,
        },
      };
    }
  } else {
    // Only execs are addressable this way, and only the ones this viewer can
    // see — loadCelebrationExecs already applies the company wall, so an id
    // outside it reads as not-found exactly like an out-of-company employee.
    const exec = (await loadCelebrationExecs(req)).find((u) => String(u._id) === String(userId));
    if (exec) {
      recipient = {
        user: exec,
        dates: {
          birthday: exec.dateOfBirth,
          anniversary: exec.dateOfJoining,
          marriage: exec.dateOfMarriage,
        },
      };
    }
  }
  if (!recipient) {
    res.status(404);
    throw new Error('Recipient not found');
  }

  // Don't let someone wish themselves.
  if (String(recipient.user._id) === String(req.user._id)) {
    res.status(400);
    throw new Error('You cannot send a wish to yourself');
  }

  const fromName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'A colleague';
  const toFirst = recipient.user.firstName || 'there';
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
  const occasionAt = occasionDateFrom(recipient.dates[kind]) || new Date();
  const expiresAt = new Date(occasionAt.getTime() + WISH_VISIBLE_DAYS_AFTER * 24 * 60 * 60 * 1000);

  await Notification.create({
    recipient: recipient.user._id,
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
      to: recipient.user.email,
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
