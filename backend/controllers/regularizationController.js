/**
 * Regularization controller — attendance-correction requests. Employees raise
 * requests to fix a day's check-in/out; HR approve/reject, and an approval APPLIES
 * the corrected times straight onto the day's Attendance record (recording a
 * before/after snapshot). HR can also regularize any employee's day directly.
 */
const asyncHandler = require('express-async-handler');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');
const { isReadOnlyExec } = require('../middleware/authMiddleware');
const { scopeUserField } = require('../utils/employeeScope');
const Setting = require('../models/Setting');
const { startOfDayIST, ymdIST, monthRangeIST } = require('../utils/dateHelpers');
const { settleStatus } = require('../utils/workday');
const { resolveShiftForDay } = require('../services/shiftResolver');
const { shiftSnapshot, rollForwardIfInverted } = require('../utils/shiftWindow');

// `role` rides along so the review screen can tell an HR's own request apart
// from an ordinary employee's (see HR_REVIEW_ROLES below).
const EMPLOYEE_FIELDS = 'firstName lastName email role';

// The day and the punches, written the way the employee reads them everywhere
// else in the portal: "14 Aug 2026", and 12-hour times with a meridiem. Node's
// en-IN emits a lowercase "pm" where the browser emits "PM", so it is upper-cased
// to match the rest of the UI.
const fmtDay = (d) => new Date(d).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
const fmtTime = (d) => (d
  ? new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
    .replace(/\b([ap])\.?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`)
  : null);

// ============ Monthly limit ============
// How many corrections one employee may raise for any single month.
// Setting.regularizationLimit is the company number (0 = no cap at all, the
// default); EmployeeProfile.regularizationMonthlyLimit overrides it for one
// person (null = follow the company, 0 = blocked outright).

/** Month key ("2026-09") of a date, in IST — the month a request is charged to. */
const monthKeyIST = (d) => ymdIST(new Date(d)).slice(0, 7);

/**
 * The cap that applies to one employee, and where it came from.
 *
 * Zero means two different things depending on where it is set, so the answer
 * carries `unlimited` rather than leaving every caller to infer it from the
 * number: org-wide 0 is "no cap at all" (what an untouched deployment carries),
 * while 0 on a profile is somebody deliberately stopped from filing. Anyone who
 * should be exempt from a company cap is given 31 — one a day, every day.
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @returns {Promise<{limit: number, unlimited: boolean, source: 'employee'|'org'}>}
 */
const limitFor = async (userId) => {
  const [settings, profile] = await Promise.all([
    Setting.getSettings(),
    EmployeeProfile.findOne({ user: userId }).select('regularizationMonthlyLimit').lean(),
  ]);
  const own = profile?.regularizationMonthlyLimit;
  // != null, not a truthiness test: 0 here is a real cap, and reading it as
  // "unset" would hand the blocked employee the org allowance instead.
  if (own != null && Number.isFinite(Number(own))) {
    return { limit: Number(own), unlimited: false, source: 'employee' };
  }
  const org = Number(settings.regularizationLimit) || 0;
  return { limit: org, unlimited: org === 0, source: 'org' };
};

/**
 * How many of that month's allowance this employee has already spent.
 *
 * Counted on the DATE BEING CORRECTED rather than when the request was typed, so
 * filing late for last month spends last month's allowance. Rejected requests do
 * not count — HR already said no, and charging the allowance as well would be a
 * second penalty for the same request.
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {string} monthKey - "YYYY-MM"
 * @returns {Promise<number>}
 */
const usedInMonth = async (userId, monthKey) => {
  const [y, m] = monthKey.split('-').map(Number);
  const { start, end } = monthRangeIST(y, m);
  return Regularization.countDocuments({
    employee: userId,
    date: { $gte: start, $lt: end },
    status: { $in: ['Pending', 'Approved'] },
  });
};

/**
 * The employee's allowance for one month, shaped for a client to render.
 * @returns {Promise<{month: string, limit: number, unlimited: boolean, used: number, remaining: number|null, source: string}>}
 */
const quotaFor = async (userId, monthKey) => {
  const { limit, unlimited, source } = await limitFor(userId);
  const used = await usedInMonth(userId, monthKey);
  return {
    month: monthKey,
    limit,
    unlimited,
    used,
    remaining: unlimited ? null : Math.max(0, limit - used),
    source,
  };
};

/**
 * The body of the decision notification.
 *
 * On approval this names the times the day now carries, taken from what was
 * actually written to the attendance record rather than from what was asked for
 * — if applying the correction partly failed, the message must not claim a
 * change that did not land. With neither punch available it falls back to a
 * plain confirmation.
 *
 * @param {Object} item the decided Regularization document
 * @param {'Approved'|'Rejected'} status
 * @param {string} [reviewNote]
 * @returns {string}
 */
function regularizationOutcome(item, status, reviewNote) {
  const day = fmtDay(item.date);
  const note = reviewNote ? ` Note: ${reviewNote}` : '';
  if (status !== 'Approved') {
    return `${day} was not changed, so the day stands as recorded.${note}`;
  }
  const parts = [];
  const inAt = fmtTime(item.appliedCheckIn);
  const outAt = fmtTime(item.appliedCheckOut);
  if (inAt) parts.push(`in ${inAt}`);
  if (outAt) parts.push(`out ${outAt}`);
  return parts.length
    ? `${day} now reads ${parts.join(', ')}.${note}`
    : `${day} has been corrected on your attendance.${note}`;
}

// HR review their own colleagues' attendance, so an HR's OWN regularization
// cannot be decided by HR — it goes up to an executive or a SuperAdmin. CEO/MD
// are read-only everywhere else; this route is a deliberate exception, the same
// shape as their existing role as reporting-chain leave approvers.
const HR_REVIEW_ROLES = ['SuperAdmin', 'CEO', 'MD'];
const HR_ROLE = 'HRManager';

/**
 * Build the configured approval ladder for an employee's regularization.
 *
 * Unlike leave, this is NOT derived from the org chart — a SuperAdmin names the
 * approvers per employee (EmployeeProfile.regularizationApprovers), because an
 * attendance correction is often signed off by a shift or ops lead rather than
 * the employee's reporting manager. 1 rung minimum, 2 maximum.
 *
 * Inactive approvers and the requester themselves are dropped (nobody signs off
 * their own attendance correction). An empty result is normal and meaningful:
 * it means "not configured", and the caller keeps the flat HR-review path.
 * @param {mongoose.Types.ObjectId} employeeUserId - the requester's User id
 * @returns {Promise<Object[]>} rungs shaped like approvalStepSchema
 */
async function buildRegularizationChain(employeeUserId) {
  const profile = await EmployeeProfile.findOne({ user: employeeUserId })
    .select('regularizationApprovers')
    .lean();
  const configured = (profile?.regularizationApprovers || []).slice(0, 2);
  if (!configured.length) return [];

  const chain = [];
  const seen = new Set([String(employeeUserId)]);
  for (const id of configured) {
    const key = String(id);
    if (seen.has(key)) continue; // no self-approval, no duplicate rung
    seen.add(key);
    const u = await User.findById(id).select('firstName lastName role isActive').lean();
    if (!u || u.isActive === false) continue;
    chain.push({
      approver: u._id,
      approverName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      role: u.role,
      order: chain.length,
      status: 'Waiting',
    });
  }
  return chain;
}

// Tell the person whose turn it is. Best-effort — a failed notification must
// never stop the request being filed or advanced.
//
// 'all', NOT 'admin'. A rung on this ladder is whoever a SuperAdmin named, and
// that is very often a shift or ops lead with no admin portal at all — the
// decision route is gated on BEING the current approver rather than on
// attendance.manage, precisely so it can be. An 'admin' notification is filtered
// out of My Portal, so the one person whose turn it was is the one person who
// could not see that it was their turn.
//
// The link is the APPROVALS queue for the same reason: that is where their turn
// appears, in either portal, whereas the Regularizations tab is an admin page
// they may not be able to open.
async function notifyRegApprover(approverUserId, item, applicantName) {
  try {
    await notify({
      recipient: approverUserId,
      type: 'regularization',
      audience: 'all',
      title: 'Regularization needs your approval',
      body: `${applicantName} raised an attendance regularization (${item.type}) - it's awaiting your approval.`,
      link: 'approvals',
    });
  } catch (err) {
    console.error('regularization approver notify failed:', err.message);
  }
}

// Tell the employee a rung decided, mirroring the leave hierarchy: they hear
// about every step, not just the final outcome.
async function notifyRegEmployeeStep(item, step, next, note) {
  try {
    const total = (item.approvalChain || []).length;
    const stepNo = (step?.order ?? 0) + 1;
    await notify({
      recipient: item.employee,
      type: 'regularization',
      audience: 'employee',
      title: `Regularization approved at step ${stepNo} of ${total}`,
      body: `${step?.approverName || 'Your approver'} approved your ${item.type} regularization. It now needs ${next?.approverName || 'the next approver'}'s approval.${note ? ` Note: ${note}` : ''}`,
      link: 'regularizations',
    });
  } catch (err) {
    console.error('regularization step notify failed:', err.message);
  }
}

/**
 * Is this request sitting with HR right now?
 *
 * HR IS THE LAST RUNG OF EVERY LADDER, and it is an implicit one: the named
 * approvers are decided through the approvals inbox, and when the last of them
 * says yes the request does NOT become Approved — it stays Pending with nobody's
 * name on it, which is precisely the state an unladdered request is born in. One
 * condition therefore answers "is this HR's to decide" for both shapes of
 * request, and it is the condition the flat HR review path has always used.
 *
 * `currentApprover: null` also matches documents predating the field, which is
 * the correct answer for them: they were always HR's.
 * @type {Object} a Mongo filter fragment
 */
const AWAITING_HR = { status: 'Pending', currentApprover: null };

/** The same question, asked of a document already in hand. */
const isAwaitingHr = (item) => item.status === 'Pending' && !item.currentApprover;

/**
 * Tell HR a request is theirs to decide.
 *
 * WHEN, and why it is not simply "on arrival". A request with a configured
 * ladder belongs to its named approver first: telling HR at the same moment
 * puts a decision in their inbox that is not theirs to make yet, and — worse —
 * one that may never become theirs, because the approver can reject it. So this
 * fires on exactly two occasions, which are the two ways a request reaches HR:
 *
 *   · on arrival, ONLY when no ladder is configured. That request goes straight
 *     to the flat HR path; nobody else is coming.
 *   · once the ladder has approved it in full, and HR becomes the final rung.
 *
 * A rejection anywhere on the ladder is the end of the request and produces
 * nothing here: it never reaches HR, so there is nothing to tell them about.
 *
 * "HR" is `attendance.manage`, which is what the Regularizations tab is gated
 * on — and, since a SuperAdmin holds every capability, the Backend is inside
 * this bench rather than notified separately. Walled to the requester's own
 * company, so another company's HR never hears about their people; SuperAdmins
 * cross the wall, as they do everywhere.
 *
 * Best-effort, like every other notifier here.
 * @param {Object} item - the Regularization doc
 * @param {{title: string, body: string, exclude?: Array}} message
 * @returns {Promise<void>}
 */
async function notifyRegHr(item, { title, body, exclude = [] }) {
  try {
    const profile = await EmployeeProfile.findOne({ user: item.employee }).select('company').lean();
    const bench = await scopeRecipientsToCompany(
      await usersHoldingAny('attendance.manage'),
      profile?.company
    );
    // The requester is excluded whatever their role: an HR raising their own
    // correction does not need telling that they raised it.
    const skip = new Set([...exclude, item.employee].filter(Boolean).map(String));
    const ids = bench.filter((id) => !skip.has(String(id)));
    if (!ids.length) return;
    await notifyMany(ids, {
      type: 'regularization',
      audience: 'admin',
      title,
      body,
      // The full admin path, not the bare 'regularizations' slug the
      // employee-facing alerts use: a bare slug navigates RELATIVE to whatever
      // page is open on the web, and on mobile it resolves to the tapper's OWN
      // regularization list rather than the review tab this alert is about.
      link: '/admin/regularizations',
    });
  } catch (err) {
    console.error('regularization HR notify failed:', err.message);
  }
}

/**
 * Tell the employee their last named approver said yes and HR now has it.
 *
 * A separate message from notifyRegEmployeeStep, which says "it now needs
 * <name>'s approval" — there is no name to give here, because the final rung is
 * the HR bench rather than one person. Saying "approved" on its own would be
 * worse: the day has not been corrected yet, and the employee would go looking
 * for a change that has not happened.
 * @param {Object} item
 * @param {Object} [step] - the rung that just approved
 * @param {string} [note]
 * @returns {Promise<void>}
 */
async function notifyRegEmployeeHandover(item, step, note) {
  try {
    await notify({
      recipient: item.employee,
      type: 'regularization',
      audience: 'employee',
      title: 'Regularization with HR for final approval',
      body: `${step?.approverName || 'Your approver'} approved your ${item.type} regularization for ${fmtDay(item.date)}.`
        + ` It now needs HR's final approval before the day is corrected.${note ? ` Note: ${note}` : ''}`,
      link: 'regularizations',
    });
  } catch (err) {
    console.error('regularization handover notify failed:', err.message);
  }
}

// Final outcome for the employee.
async function notifyRegEmployeeDecision(item, note) {
  try {
    const approved = item.status === 'Approved';
    await notify({
      recipient: item.employee,
      type: 'regularization',
      audience: 'employee',
      title: `Regularization ${approved ? 'approved' : 'rejected'}`,
      body: `Your ${item.type} regularization has been ${approved ? 'approved' : 'rejected'}.${note ? ` Note: ${note}` : ''}`,
      link: 'regularizations',
    });
  } catch (err) {
    console.error('regularization decision notify failed:', err.message);
  }
}

// 'HH:mm' (or a full date string) + the request's day → a concrete Date on
// that IST day. Returns undefined when the value is empty/unparseable.
function timeOnDay(day, value) {
  if (!value) return undefined;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    return new Date(startOfDayIST(day).getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Apply an approved regularization to the employee's Attendance record for
// that day (creating the record if the day has none). Filling a check-out
// clears any "no punch-out" mark via the Attendance pre-save hook.
async function applyToAttendance(item, reviewer) {
  const profile = await EmployeeProfile.findOne({ user: item.employee });
  if (!profile) throw new Error('No employee profile linked to this user');

  const day = startOfDayIST(item.date);
  let record = await Attendance.findOne({ employee: profile._id, date: day });
  const isNew = !record;
  // Snapshot the BEFORE state so the audit view can show "from → to".
  const prevStatus = isNew ? 'No record' : record.status;
  const prevIn = isNew ? null : record.checkIn;
  const prevOut = isNew ? null : record.checkOut;
  if (!record) {
    record = new Attendance({ employee: profile._id, date: day, status: 'Present' });
  }
  const inAt = timeOnDay(item.date, item.requestedCheckIn);
  let outAt = timeOnDay(item.date, item.requestedCheckOut);
  // This path writes a check-in, so lateMinutes WILL judge the day — it needs
  // to know which shift it is being judged against. Resolved as of the RECORD'S
  // day, never today's: a regularization filed on Friday for Tuesday must be
  // measured against Tuesday's shift.
  if (!record.shift) {
    const shift = await resolveShiftForDay(profile, day);
    Object.assign(record, shiftSnapshot(shift) || {});
  }
  if (inAt) record.checkIn = inAt;
  // A 'Forgot Check-out' request carries only a time-of-day, and timeOnDay can
  // only anchor it to the request's OWN day — so a shift that ended after
  // midnight ("00:15") resolves to 00:15 that morning, hours BEFORE the check-in.
  // Left alone the pair inverts, effectiveHours collapses the negative span to 0,
  // and the day-minimum rule reads that as a zero-hour day and charges a full
  // day's pay for a shift that actually ran ten hours. Roll it forward to the
  // next day instead, which is what an after-midnight close means.
  //
  // The sibling HR-edit path already refuses an inverted pair outright
  // (updateRecord: "Check-out has to be after check-in."); this is the path
  // employees are actually pointed at, so it had no such protection at all.
  // Shared with the HR-edit path (attendanceController.updateRecord) so the two
  // cannot disagree about what an after-midnight close means.
  const effectiveIn = inAt || record.checkIn;
  if (outAt && effectiveIn) outAt = rollForwardIfInverted(new Date(effectiveIn), outAt);
  if (outAt) record.checkOut = outAt;
  if (record.checkIn && record.status === 'Absent') record.status = 'Present';
  // Re-derive the day from the corrected punches. This is what "half day until
  // regularization" means: a day auto-halved for short hours (or for a missing
  // punch-out counted to 7 PM) is restored to Present once the real times show
  // a full day — and stays a half day if they don't.
  record.status = settleStatus(record) || record.status;
  const note = `Regularized (${item.type}) by ${reviewer?.fullName || 'HR'}: ${item.reason}`;
  record.remarks = record.remarks ? `${record.remarks} · ${note}` : note;
  await record.save();

  // Persist the before/after on the regularization for oversight (best-effort).
  item.previousStatus = prevStatus;
  item.previousCheckIn = prevIn || undefined;
  item.previousCheckOut = prevOut || undefined;
  item.appliedCheckIn = record.checkIn;
  item.appliedCheckOut = record.checkOut;
  try { await item.save(); } catch (err) { console.error('Regularization audit save failed:', err.message); }
  return record;
}

/**
 * List the caller's own regularization requests, newest first, with this
 * month's allowance so the screen can say what is left before they type a
 * request the POST below would refuse.
 * @route GET /api/regularizations/me
 * @returns {{count: number, items: Object[], quota: {month, limit, unlimited, used, remaining, source}}}
 */
// GET /api/regularizations/me  — the caller's own requests
const listMine = asyncHandler(async (req, res) => {
  const [items, quota] = await Promise.all([
    Regularization.find({ employee: req.user._id }).sort({ createdAt: -1 }).lean(),
    quotaFor(req.user._id, monthKeyIST(new Date())),
  ]);
  // "Pending" alone cannot tell the employee whether anyone has looked at it
  // yet. Their own request now has two waiting rooms — their approver's, then
  // HR's — and which one it is in is the thing they actually want to know.
  res.json({
    count: items.length,
    items: items.map((r) => ({
      ...r,
      awaitingHr: isAwaitingHr(r),
      waitingOn: isAwaitingHr(r) ? null
        : (r.approvalChain || []).find((s) => String(s.approver) === String(r.currentApprover))?.approverName || null,
    })),
    quota,
  });
});

/**
 * Employee raises a regularization request (status Pending).
 * @route POST /api/regularizations
 * @param {string} req.body.date - required
 * @param {string} req.body.reason - required
 * @param {string} [req.body.type]
 * @param {string} [req.body.requestedCheckIn] - 'HH:mm' or date string
 * @param {string} [req.body.requestedCheckOut] - 'HH:mm' or date string
 * @returns {{item: Object}} (201)
 */
// POST /api/regularizations  { date, type, requestedCheckIn, requestedCheckOut, reason }
const createRequest = asyncHandler(async (req, res) => {
  const { date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;

  if (!date || !reason) {
    res.status(400);
    throw new Error('date and reason are required');
  }
  // Read before the month below is taken out of it: an unparseable date makes
  // ymdIST throw a bare RangeError, which reaches the employee as a 500 with
  // nothing to act on. Mongoose would have refused it a few lines later anyway.
  if (Number.isNaN(new Date(date).getTime())) {
    res.status(400);
    throw new Error('That date could not be read. Pick the day you want corrected.');
  }

  // The monthly cap, charged to the month of the day being corrected — see
  // limitFor. Checked before the chain is built so a refused request costs
  // nothing, and skipped entirely where no cap applies, which is what an
  // untouched deployment carries.
  const { limit, unlimited } = await limitFor(req.user._id);
  if (!unlimited) {
    const monthKey = monthKeyIST(date);
    const used = await usedInMonth(req.user._id, monthKey);
    if (used >= limit) {
      res.status(400);
      const monthName = new Date(`${monthKey}-01T00:00:00+05:30`)
        .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
      // A limit of 0 is not "you have used them all" — that employee never had
      // any, and telling them to wait for next month would be a lie.
      throw new Error(limit === 0
        ? 'Regularization requests are turned off for your account. Ask HR to raise the correction for you.'
        : `You have used all ${limit} regularization${limit === 1 ? '' : 's'} allowed for ${monthName}. `
          + 'Ask HR to raise the correction for you, or to change your monthly limit.');
    }
  }

  // A configured ladder routes the request to named approvers; with none
  // configured it stays on the flat "any HR reviewer" path it has always used.
  const chain = await buildRegularizationChain(req.user._id);
  if (chain.length) chain[0].status = 'Pending';

  const item = await Regularization.create({
    employee: req.user._id,
    date,
    type,
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Pending',
    approvalChain: chain,
    currentApprover: chain.length ? chain[0].approver : null,
  });

  const name = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'An employee';
  if (chain.length) {
    // The ladder owns it now. HR is told when — and only if — the ladder
    // approves it in full; see notifyRegHr. Telling them both at once put a
    // decision in HR's inbox that was not theirs yet and might never be.
    await notifyRegApprover(chain[0].approver, item, name);
  } else {
    // No ladder: the request falls to the flat HR path, where HR is the sole
    // reviewer. If they are not told now, nobody is coming.
    await notifyRegHr(item, {
      title: 'New regularization request',
      body: `${name} raised a ${item.type} regularization for ${fmtDay(item.date)}.`,
    });
  }

  res.status(201).json({ item });
});

/**
 * List all regularization requests, optionally filtered by status (admin).
 * @route GET /api/regularizations  (admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, items: Object[]}} with populated employee/reviewedBy
 */
// GET /api/regularizations  (admin) — optional ?status filter
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  // ?awaitingHr=true — the DECISION QUEUE rather than the desk. An approvals
  // inbox must list exactly what the badge beside it counts, and since HR became
  // the final rung those are no longer all the Pending ones: a request still
  // climbing its ladder is somebody else's turn. The desk (the Regularizations
  // tab) deliberately does NOT pass this — it shows everything, labelled.
  if (String(req.query.awaitingHr) === 'true') Object.assign(filter, AWAITING_HR);
  // Company wall: only requests from employees this admin may see
  // (Regularization.employee is a User id). No-op for unrestricted viewers.
  await scopeUserField(req, filter);

  const items = await Regularization.find(filter)
    .populate('employee', EMPLOYEE_FIELDS)
    .populate('reviewedBy', 'firstName lastName role') // who did the regularization
    .sort({ createdAt: -1 })
    .lean();
  // WHOSE TURN IT IS, stamped on every row. Every Pending request used to be
  // HR's to decide, so the queue needed no such distinction; now a Pending one
  // may still be climbing its ladder, and a queue that cannot tell the two apart
  // invites HR to decide requests the named approver has not seen — which is an
  // override, and works, but is not what the list looks like it is offering.
  res.json({
    count: items.length,
    items: items.map((r) => ({
      ...r,
      awaitingHr: isAwaitingHr(r),
      // Who it is sitting with, when that is not HR. Read off the chain rather
      // than populated, so this costs no extra query.
      waitingOn: isAwaitingHr(r) ? null
        : (r.approvalChain || []).find((s) => String(s.approver) === String(r.currentApprover))?.approverName || null,
    })),
  });
});

/**
 * Approve or reject a request; approval applies the fix to the Attendance record.
 * @route PATCH /api/regularizations/:id/status  (admin)
 * @param {string} req.params.id - request id
 * @param {string} req.body.status - 'Approved' or 'Rejected'
 * @param {string} [req.body.reviewNote]
 * @returns {{item: Object, applied: boolean}}
 * @sideeffect on approval writes to Attendance; notifies the employee either way
 */
// PATCH /api/regularizations/:id/status  (admin)  { status, reviewNote }
// Approving now also APPLIES the requested times to the day's Attendance
// record, so the fix is visible everywhere immediately.
// The requester's display name, for approver-facing notifications. Never throws:
// it is called as an argument to the notify helpers, i.e. OUTSIDE their own
// try/catch, and the request has already been saved by then — a lookup failure
// must not turn a completed approval into a 500.
async function applicantNameOf(userId) {
  try {
    const u = await User.findById(userId).select('firstName lastName').lean();
    return `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'An employee';
  } catch {
    return 'An employee';
  }
}

/**
 * Configured-ladder decision — the normal path once a SuperAdmin has named
 * approvers. The acting user MUST be the current approver, so an ordinary
 * employee named as an approver can decide without holding attendance.manage.
 *
 * Approve → advance to the next rung, or, on the last NAMED rung, hand the
 * request to HR, who are the final rung of every ladder: it stays Pending with
 * no current approver, which is the AWAITING_HR state, and attendance is left
 * untouched until HR decides. Reject → stop the chain immediately.
 *
 * Nothing here writes to the attendance record except the SuperAdmin override,
 * which is the one case where the decider is also the final authority. A 2-step
 * request must not touch attendance after step 1, and no request may touch it
 * before HR has seen it.
 * @param {Object} item - the Regularization doc (mutated + saved)
 * @param {*} userId - the acting approver
 * @param {'approve'|'reject'} action
 * @param {string} [note]
 * @param {Object} [actor] - req.user, used to attribute the attendance remark
 * @returns {Promise<{item: Object, applied: boolean}>}
 * @throws {Error} with `.status` on a bad transition
 */
async function advanceRegularizationApproval(item, userId, action, note, actor) {
  if (item.status !== 'Pending') {
    const err = new Error(`Cannot ${action} - this request is ${item.status}.`);
    err.status = 400;
    throw err;
  }
  // The Backend decides anything, from anywhere — the same override it already
  // had from the Regularizations page, now reachable from the approvals inbox
  // where the request is actually visible to it.
  const override = !item.currentApprover || String(item.currentApprover) !== String(userId);
  if (override && !(actor && actor.role === 'SuperAdmin')) {
    const err = new Error('This regularization is not awaiting your approval.');
    err.status = 403;
    throw err;
  }
  // Belt and braces: the chain builder already refuses to add the requester.
  if (String(item.employee) === String(userId)) {
    const err = new Error('You cannot review your own regularization request.');
    err.status = 403;
    throw err;
  }

  const now = new Date();
  const step = (item.approvalChain || []).find(
    (s) => String(s.approver) === String(userId) && s.status === 'Pending'
  );

  // Void the rungs that never got their turn and tell them it is off their
  // plate. With no Waiting rung left, the flow below takes the last-rung path
  // and the correction is applied — matching what the Regularizations page does.
  if (override) {
    const overridden = (item.approvalChain || []).filter(
      (st) => st.status === 'Pending' || st.status === 'Waiting'
    );
    for (const st of overridden) st.status = 'Skipped';
    if (overridden.length) {
      try {
        const who = await applicantNameOf(item.employee);
        await notifyMany(overridden.map((st) => st.approver).filter(Boolean), {
          type: 'regularization',
          // 'all', like notifyRegApprover: a named approver may have no admin portal.
          audience: 'all',
          title: `Regularization ${action === 'approve' ? 'approved' : 'rejected'} by the Backend`,
          body: `${who}'s ${item.type} regularization was decided by a Super Admin - no action is needed from you.`,
          link: 'regularizations',
        });
      } catch (err) {
        console.error('regularization override notify failed:', err.message);
      }
    }
  }

  if (action === 'reject') {
    if (step) { step.status = 'Rejected'; step.decidedAt = now; step.note = note; }
    for (const s of item.approvalChain || []) {
      if (s.status === 'Waiting') s.status = 'Skipped';
    }
    item.status = 'Rejected';
    item.currentApprover = null;
    item.reviewedBy = userId;
    item.reviewedAt = now;
    item.reviewNote = note;
    await item.save();
    await notifyRegEmployeeDecision(item, note);
    return { item, applied: false };
  }

  const next = (item.approvalChain || []).find(
    (s) => s.status === 'Waiting' && (!step || s.order > step.order)
  );
  if (next) {
    if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
    next.status = 'Pending';
    item.currentApprover = next.approver;
    await item.save();
    await notifyRegApprover(next.approver, item, await applicantNameOf(item.employee));
    await notifyRegEmployeeStep(item, step, next, note);
    return { item, applied: false };
  }

  // The last NAMED rung. HR is the rung after it, so this is a hand-over, not a
  // finalisation: the request stays Pending with nobody's name on it, which is
  // the state that puts it in front of HR (see AWAITING_HR). Attendance is NOT
  // touched — the correction takes effect when HR says so, and applying it here
  // would make HR's decision cosmetic.
  if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
  item.currentApprover = null;

  // The one exception is the Backend overriding the ladder. A SuperAdmin
  // deciding from the approvals inbox IS the final authority — they hold every
  // capability, so routing their approval on to the HR bench they are already
  // in would park the request in front of the person who just approved it.
  if (override) {
    item.status = 'Approved';
    item.reviewedBy = userId;
    item.reviewedAt = now;
    item.reviewNote = note;
    await item.save();
    let applied = null;
    try {
      applied = await applyToAttendance(item, actor);
    } catch (err) {
      // Same rule as the HR path: the decision stands even if applying fails.
      console.error('Regularization apply failed:', err.message);
    }
    await notifyRegEmployeeDecision(item, note);
    return { item, applied: !!applied };
  }

  await item.save();

  const who = await applicantNameOf(item.employee);
  const decidedBy = step?.approverName || 'Their approver';
  await notifyRegEmployeeHandover(item, step, note);
  await notifyRegHr(item, {
    title: 'Regularization needs your final approval',
    body: `${decidedBy} approved ${who}'s ${item.type} regularization for ${fmtDay(item.date)}.`
      + ' It is with you for the final approval.',
    // Everyone who signed it off already knows; an approver who also holds
    // attendance.manage would otherwise be told to approve their own approval.
    exclude: (item.approvalChain || []).map((s) => s.approver),
  });
  return { item, applied: false };
}

/**
 * WHO may decide a regularization from HR's side, whatever ladder it is on.
 *
 * Three refusals, and every one of them is a control rather than a convenience,
 * which is why they live here instead of being written out at each entry point:
 * HR's final approval is reachable from the Regularizations tab AND from the
 * approvals inbox now, and a rule enforced at one door is not a rule.
 *
 * Throws with `.status` set, in the shape advanceRegularizationApproval uses, so
 * either caller can pass it straight to the error handler.
 * @param {Object} actor - req.user
 * @param {Object} item - the Regularization doc
 * @returns {Promise<void>}
 */
async function assertCanDecideAsHr(actor, item) {
  const refuse = (status, message) => {
    const err = new Error(message);
    err.status = status;
    throw err;
  };
  // Nobody signs off their own attendance correction, whatever their role.
  if (String(item.employee) === String(actor._id)) {
    refuse(403, 'You cannot review your own regularization request.');
  }
  // An HR's own request needs an executive or a SuperAdmin — HR reviewing HR
  // (each other's, or their own via a colleague) would defeat the control.
  const requester = await User.findById(item.employee).select('role');
  if (requester?.role === HR_ROLE && !HR_REVIEW_ROLES.includes(actor.role)) {
    refuse(403, 'An HR regularization can only be approved by the CEO, MD or a Super Admin.');
  }
  // …and the exception goes no further: a VIEW-ONLY exec's write access here
  // covers HR requests only. Everyone else's still belongs to HR, so they stay
  // read-only on those, as on every other admin screen. (An exec a SuperAdmin
  // has put in edit mode decides any request, like HR.)
  if (isReadOnlyExec(actor) && requester?.role !== HR_ROLE) {
    refuse(403, 'CEO/MD accounts review HR regularizations only; this one is for HR to decide.');
  }
}

/**
 * HR's decision — the final rung of every ladder, and the whole of the review
 * for a request that never had one.
 *
 * Extracted from the route so the approvals inbox can reach the SAME code: HR
 * used to decide only from the Regularizations tab, and bolting a second
 * implementation onto the inbox would have given the two doors different rules
 * about self-review, HR's own corrections and view-only executives.
 *
 * @param {Object} item - the Regularization doc (mutated + saved)
 * @param {Object} actor - req.user
 * @param {'Approved'|'Rejected'} status
 * @param {string} [reviewNote]
 * @returns {Promise<{item: Object, applied: boolean}>}
 * @throws {Error} with `.status` when this account may not decide it
 */
async function decideAsHr(item, actor, status, reviewNote) {
  if (!['Approved', 'Rejected'].includes(status)) {
    const err = new Error('status must be Approved or Rejected');
    err.status = 400;
    throw err;
  }
  await assertCanDecideAsHr(actor, item);

  // This is BOTH halves of HR's role now, and which one it is depends
  // entirely on whether any rung is still live:
  //
  //   · no live rung — the normal final approval. A request that has cleared its
  //     ladder (or never had one) is HR's own turn, so `overridden` comes back
  //     empty and nothing below fires. This is the common path.
  //   · a live rung — HR is stepping OVER a named approver who has not decided.
  //     Still allowed, deliberately: it is the valve that unsticks a request
  //     whose approver is away, and it mirrors the leave override. The rungs
  //     that never got their turn are voided and told, so the request cannot sit
  //     in their inbox as a ghost.
  //
  // The clients label the two so nobody overrides by accident — see the
  // `awaitingHr` / `waitingOn` fields listAll stamps on each row.
  const overridden = (item.approvalChain || []).filter(
    (s) => s.status === 'Pending' || s.status === 'Waiting'
  );
  for (const s of overridden) s.status = 'Skipped';
  item.currentApprover = null;

  item.status = status;
  item.reviewNote = reviewNote;
  item.reviewedBy = actor._id;
  item.reviewedAt = new Date();
  await item.save();

  if (overridden.length) {
    const name = await applicantNameOf(item.employee);
    try {
      await notifyMany(
        overridden.map((s) => s.approver).filter(Boolean),
        {
          type: 'regularization',
          // 'all', like notifyRegApprover: a named approver may have no admin portal.
          audience: 'all',
          title: `Regularization ${status.toLowerCase()} by HR`,
          body: `${name}'s ${item.type} regularization was ${status.toLowerCase()} by HR - no action is needed from you.`,
          link: 'regularizations',
        }
      );
    } catch (err) {
      console.error('regularization override notify failed:', err.message);
    }
  }

  let applied = null;
  if (status === 'Approved') {
    try {
      applied = await applyToAttendance(item, actor);
    } catch (err) {
      // The decision stands even if applying fails (e.g. no profile) — HR can
      // still fix the record manually from the attendance views.
      console.error('Regularization apply failed:', err.message);
    }
  }

  notify({
    recipient: item.employee,
    type: 'regularization',
    audience: 'employee',
    title: status === 'Approved' ? 'Attendance corrected' : 'Regularization not approved',
    // Say what actually changed, not just that something did. "Your request was
    // approved" leaves the employee to go and look up what their day now reads
    // as; the corrected punches are the whole point of the request, so they
    // belong in the line they are already reading.
    body: regularizationOutcome(item, status, reviewNote),
    link: 'regularizations',
  }).catch(() => {});

  return { item, applied: !!applied };
}

/**
 * HR decides a request from the Regularizations tab.
 * @route PATCH /api/regularizations/:id/status  (admin)
 * @param {string} req.params.id
 * @param {'Approved'|'Rejected'} req.body.status
 * @param {string} [req.body.reviewNote]
 * @returns {{item: Object, applied: boolean}}
 */
const reviewRequest = asyncHandler(async (req, res) => {
  const item = await Regularization.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Regularization request not found');
  }
  try {
    res.json(await decideAsHr(item, req.user, req.body.status, req.body.reviewNote));
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
});

/**
 * HR regularizes any employee's day directly (recorded pre-Approved and applied).
 * @route POST /api/regularizations/admin  (admin)
 * @param {string} req.body.employee - target user id (required)
 * @param {string} req.body.date - required
 * @param {string} req.body.reason - required
 * @param {string} [req.body.type='Other']
 * @param {string} [req.body.requestedCheckIn]
 * @param {string} [req.body.requestedCheckOut]
 * @returns {{item: Object, record: Object}} (201)
 * @sideeffect writes to the day's Attendance record; notifies the employee
 */
// POST /api/regularizations/admin  (admin)
// { employee (User id), date, type, requestedCheckIn, requestedCheckOut, reason }
// HR regularizes any employee's attendance directly: the request is recorded
// as already Approved (for the audit trail) and applied to the day's record.
//
// Deliberately NOT capped by the monthly limit the employee route enforces: the
// cap exists to stop an employee filing endlessly, and HR is the one enforcing
// it — leaving them no way to fix a genuine eleventh correction would make the
// limit a trap rather than a policy. It still counts towards the month, so the
// employee's own allowance reflects it.
const adminCreate = asyncHandler(async (req, res) => {
  const { employee, date, type, requestedCheckIn, requestedCheckOut, reason } = req.body;
  if (!employee || !date || !reason) {
    res.status(400);
    throw new Error('employee, date and reason are required');
  }

  // A direct regularization is self-approved by definition, so HR must not be
  // able to aim it at an HR (themselves or a colleague) — that would walk
  // straight around the review rule in reviewRequest above. They raise a
  // request instead, and an executive or SuperAdmin decides it.
  const target = await User.findById(employee).select('role');
  if (target?.role === HR_ROLE && !HR_REVIEW_ROLES.includes(req.user.role)) {
    res.status(403);
    throw new Error(
      String(employee) === String(req.user._id)
        ? 'You cannot regularize your own attendance. Raise a request for the CEO, MD or a Super Admin to approve.'
        : "An HR's attendance can only be regularized by the CEO, MD or a Super Admin.",
    );
  }

  const item = await Regularization.create({
    employee,
    date,
    type: type || 'Other',
    requestedCheckIn,
    requestedCheckOut,
    reason,
    status: 'Approved',
    reviewedBy: req.user._id,
    reviewedAt: new Date(),
    reviewNote: 'Regularized directly by HR',
  });

  const record = await applyToAttendance(item, req.user);

  notify({
    recipient: employee,
    type: 'regularization',
    audience: 'employee',
    title: 'Your attendance was regularized',
    body: `HR updated your attendance for ${new Date(date).toLocaleDateString('en-IN', { dateStyle: 'medium' })}: ${reason}`,
    link: 'attendance',
  }).catch(() => {});

  res.status(201).json({ item, record });
});

module.exports = {
  listMine, createRequest, listAll, reviewRequest, adminCreate,
  // Used by the shared approvals inbox (controllers/approvalController.js).
  // advanceRegularizationApproval moves a NAMED rung; decideAsHr is the final
  // rung, and the inbox needs both because it now shows both.
  advanceRegularizationApproval,
  decideAsHr,
  // "It is HR's turn" — exported so the HR badge counts the same requests this
  // module hands to HR. Spelled out in two places, the badge and the queue drift
  // the first time either is touched, and a badge that disagrees with the list
  // behind it is worse than no badge.
  AWAITING_HR,
};
