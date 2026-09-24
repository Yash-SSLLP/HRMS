/**
 * Approval controller — the approver's inbox for leave and resignation/exit
 * requests. Both climb a reporting-hierarchy approval chain (logic lives in
 * leaveController/exitController); this exposes list/approve/reject per approver
 * and self-heals Pending requests whose chain was never built.
 */
const asyncHandler = require('express-async-handler');
const { LeaveRequest, EMERGENCY_LEAVE } = require('../models/Leave');
const ExitRequest = require('../models/ExitRequest');
const { openHoldingsFor } = require('../services/assetHoldings');
const AssetAssignment = require('../models/AssetAssignment');
const Regularization = require('../models/Regularization');
const Attendance = require('../models/Attendance');
const { advanceRegularizationApproval, decideAsHr, AWAITING_HR } = require('./regularizationController');
const { listWorkOnLeaveClaims, decideWorkOnLeave } = require('./attendanceController');
const { advanceApproval, ensureApprovalChain } = require('./leaveController');
const {
  advanceExitApproval,
  ensureExitApprovalChain,
  recordClearanceSection,
} = require('./exitController');
// Everything below this line serves countHrApprovals only — the HR-WIDE inbox
// tally. Each import belongs to one of the queues the admin Approvals screen
// lists (or, for payslip requests, to the sidebar badge on its own page), and
// each is counted with that queue's own gate and company-wall helper (see that
// function).
const Expense = require('../models/Expense');
const TravelRequest = require('../models/TravelRequest');
const Loan = require('../models/Loan');
const ChangeRequest = require('../models/ChangeRequest');
const DocumentChangeRequest = require('../models/DocumentChangeRequest');
const Payroll = require('../models/Payroll');
// THE EMPLOYEE LEDGER IS A DISCRIMINATOR, NOT ITS OWN COLLECTION, and models/
// KhataEntry.js is the LEGACY model it replaced — an empty collection nothing
// writes to any more. Import that one by its obvious name and every khata badge
// counts 0 for ever, with nothing to show for it. The controller that owns these
// queues resolves it exactly this way (see khataController's own require).
const KhataEntry = require('../models/CashbookEntry').EmployeeLedgerEntry;
// The BASE model, deliberately: it spans both ledgers, and so does the Vouchers
// tab this badges (GET /cashbook/entries?status=Pending queries the base too).
// The badge has to show what the page shows.
const CashbookEntry = require('../models/CashbookEntry');
const Candidate = require('../models/Candidate');
const InvestmentDeclaration = require('../models/InvestmentDeclaration');
const { Enrollment, CourseReport, CourseComment } = require('../models/Course');
const { CHANGE_INBOX_ROLES } = require('./changeRequestController');
const { canReadOthersDocs } = require('./documentController');
const { countOpenComplaints } = require('./complaintController');
const { countOpenResetRequests } = require('./passwordResetRequestController');
const { countMyOpenTasks } = require('./taskController');
const { countDueConfirmations } = require('./lifecycleController');
const { countPendingJobRequests } = require('./jobRequestController');
const { countPendingSalaryChanges } = require('./salaryChangeController');
const {
  hasPermission, isPortalViewer, isExecViewer, canApproveSelfPayslip, canApproveAdvances,
} = require('../middleware/authMiddleware');
const { scopeEmployeeFilter, scopeUserField } = require('../utils/employeeScope');
const { scopeEntryAccounts } = require('./cashbookController');

/**
 * Does this account see EVERY inbox, not just its own rung?
 *
 * The Backend does. A ladder is a routing device — it says whose turn it is —
 * and routing must not decide what the person who administers the system is
 * allowed to know about. Before this, a request addressed to an HR Manager was
 * invisible to the SuperAdmin unless they went looking for it on the module's
 * own admin page, which is not where anyone looks for "what needs deciding".
 *
 * Deliberately SuperAdmin alone. An HR Manager or a CEO/MD still sees their own
 * rung: widening it for them would put every employee's leave in the inbox of
 * people who are not on those ladders for a reason.
 * @param {object|null} user
 * @returns {boolean}
 */
const seesAllApprovals = (user) => user?.role === 'SuperAdmin';

/**
 * Does this account see EVERY leave request, rather than only its own rung?
 *
 * The Backend does, for the reason above — and so does a CEO or MD, which is the
 * one place the rule is wider than seesAllApprovals. Leave deliberately does not
 * ask an executive to sign each request, but it does let them overrule any of
 * them (leaveController's canOverrideLeave), and an authority you cannot see the
 * subject of is not an authority anyone can use. The queue is walled by COMPANY
 * instead of by rung — see listMyLeaveApprovals.
 *
 * Still only leave: exits, regularizations and clearances keep the narrow rule,
 * because nobody asked for those and widening them would put every resignation
 * in an inbox that was never meant to hold one.
 * @param {object|null} user
 * @returns {boolean}
 */
const seesAllLeave = (user) => seesAllApprovals(user) || isExecViewer(user);

/**
 * The inbox filter for a chain-driven request type.
 * @param {object} user - the signed-in user
 * @param {string} scope - 'pending' | 'history'
 * @returns {Object} a Mongo filter
 */
function chainInboxFilter(user, scope) {
  const all = seesAllApprovals(user);
  if (scope === 'history') return all ? {} : { 'approvalChain.approver': user._id };
  return all ? { status: 'Pending' } : { currentApprover: user._id, status: 'Pending' };
}

/**
 * Emergency leaves this person was told about and has not yet ruled on.
 *
 * A SEPARATE QUEUE FROM 'pending', because it is a different kind of waiting.
 * A pending leave is waiting to happen; an emergency leave has ALREADY happened
 * — it was granted the instant it was filed — and what is waiting is only
 * whether anybody agrees that it should have. Merging the two would put days
 * already taken into a queue whose buttons say Approve.
 *
 * `currentApprover` is null on these (nobody's turn was ever required), so the
 * chain filter above finds none of them. Membership is instead "was I informed":
 * a rung on the recorded ladder, or one of the executives in `execsToNotify` —
 * exactly the rule leaveController's assertLeaveReviewer enforces on the
 * write, so the queue cannot offer a button the API would refuse.
 * @param {object} user
 * @returns {Object} a Mongo filter
 */
function emergencyReviewFilter(user) {
  const mine = seesAllLeave(user) ? {} : {
    $or: [
      { 'approvalChain.approver': user._id },
      { execsToNotify: user._id },
    ],
  };
  return {
    ...mine,
    leaveType: EMERGENCY_LEAVE,
    // Withdrawn by the employee: there is nothing left to agree or disagree with.
    status: { $ne: 'Cancelled' },
    // Absent sub-document reads as Pending — every row filed before the review
    // existed is genuinely unreviewed, so it belongs in the queue.
    $and: [{
      $or: [
        { 'emergencyReview.status': 'Pending' },
        { 'emergencyReview.status': { $exists: false } },
        { emergencyReview: null },
      ],
    }],
  };
}

// Rebuild the approval chain for any Pending request that has none yet (created
// before the hierarchy feature, or by an older backend). Runs on inbox load so
// stuck requests route to the right approver from the live org-chart hierarchy.
async function healOrphanChains() {
  const orphans = await LeaveRequest.find({
    status: 'Pending',
    $or: [{ currentApprover: null }, { currentApprover: { $exists: false } }],
    $and: [{ $or: [{ approvalChain: { $exists: false } }, { approvalChain: { $size: 0 } }] }],
  });
  for (const r of orphans) {
    try { await ensureApprovalChain(r); } catch (err) { console.error('heal chain failed:', err.message); }
  }
}

// Populate an approver-facing view of a leave request.
function populateLeave(query) {
  return query
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
}

/**
 * List leave requests for the current approver.
 * @route GET /api/approvals/leave?scope=pending|history|emergency
 * @param {string} [req.query.scope] - 'pending' (awaiting my decision), 'history'
 *   (any request I'm in the chain of), or 'emergency' (granted already, awaiting
 *   my confirm/reject)
 * @returns {{scope, count, requests: Object[]}}
 * @sideeffect heals orphaned Pending chains on load
 */
// GET /api/approvals/leave?scope=pending|history|emergency
// pending   → requests awaiting MY decision right now (the action list).
// history   → every request I appear anywhere in the chain of, so a higher
//             approver (e.g. a CEO) can see one a lower manager already rejected.
// emergency → leave that was granted on filing and that I was told about, which
//             nobody has yet confirmed or rejected. Its own queue on purpose —
//             see emergencyReviewFilter.
const listMyLeaveApprovals = asyncHandler(async (req, res) => {
  await healOrphanChains();
  const scope = ['history', 'emergency'].includes(req.query.scope) ? req.query.scope : 'pending';
  const all = seesAllLeave(req.user);
  let filter;
  if (scope === 'emergency') filter = emergencyReviewFilter(req.user);
  else if (all) filter = scope === 'history' ? {} : { status: 'Pending' };
  else filter = chainInboxFilter(req.user, scope);
  // A queue that is not scoped by RUNG has to be scoped by COMPANY instead —
  // otherwise one company's executive would open the inbox on the other's
  // people. The Backend is unrestricted and this is a no-op for them.
  if (all) filter = await scopeEmployeeFilter(req, filter);
  const requests = await populateLeave(LeaveRequest.find(filter));
  res.json({ scope, count: requests.length, requests });
});

/**
 * Approve a leave request at the current chain step (may finalise or advance it).
 * @route PATCH /api/approvals/leave/:id/approve
 * @param {string} req.params.id - leave request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/leave/:id/approve
const approveLeave = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await advanceApproval(request, req.user._id, 'approve', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

/**
 * Reject a leave request at the current chain step.
 * @route PATCH /api/approvals/leave/:id/reject
 * @param {string} req.params.id - leave request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/leave/:id/reject
const rejectLeave = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await advanceApproval(request, req.user._id, 'reject', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// ================= Resignation / Exit approvals =================
// Same reporting-hierarchy ladder as leave, on the ExitRequest model. A fully
// approved resignation enters the notice period (status 'InClearance'); a
// rejection cancels it. See advanceExitApproval in exitController.

// Rebuild the chain for any Pending resignation that has none (created before
// this feature, or submitted with no manager). Runs on inbox load.
async function healExitOrphanChains() {
  const orphans = await ExitRequest.find({
    status: 'Pending',
    type: 'Resignation',
    $or: [{ currentApprover: null }, { currentApprover: { $exists: false } }],
    $and: [{ $or: [{ approvalChain: { $exists: false } }, { approvalChain: { $size: 0 } }] }],
  });
  for (const r of orphans) {
    try { await ensureExitApprovalChain(r); } catch (err) { console.error('heal exit chain failed:', err.message); }
  }
}

function populateExit(query) {
  return query
    .populate({
      path: 'employee',
      select: 'employeeCode user designation department',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('approver', 'firstName lastName role')
    .sort({ createdAt: -1 });
}

/**
 * List resignation/exit requests for the current approver.
 * @route GET /api/approvals/exits?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' or 'history'
 * @returns {{scope, count, requests: Object[]}}
 * @sideeffect heals orphaned Pending exit chains on load
 */
// GET /api/approvals/exits?scope=pending|history
const listMyExitApprovals = asyncHandler(async (req, res) => {
  await healExitOrphanChains();
  const me = req.user._id;
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const filter = chainInboxFilter(req.user, scope);
  const requests = await populateExit(ExitRequest.find(filter));
  res.json({ scope, count: requests.length, requests });
});

/**
 * Approve a resignation/exit at the current chain step (final approval starts the
 * notice period / InClearance).
 * @route PATCH /api/approvals/exits/:id/approve
 * @param {string} req.params.id - exit request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/exits/:id/approve
const approveExit = asyncHandler(async (req, res) => {
  const request = await ExitRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    await advanceExitApproval(request, req.user._id, 'approve', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

/**
 * Reject a resignation/exit at the current chain step (cancels it).
 * @route PATCH /api/approvals/exits/:id/reject
 * @param {string} req.params.id - exit request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/approvals/exits/:id/reject
const rejectExit = asyncHandler(async (req, res) => {
  const request = await ExitRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    await advanceExitApproval(request, req.user._id, 'reject', req.body.note, req.user);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// ================= No-dues clearance (assigned managers) =================
// A department manager (assigned per-exit by HR) ticks the no-dues section they
// own. Scoped to sections where `assignedTo === me`; the tick logic + guard live
// in exitController.recordClearanceSection.

/**
 * List exits with a no-dues section assigned to the current user.
 * @route GET /api/approvals/clearances?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (my section still open, InClearance) or 'history'
 * @returns {{scope, count, requests: Object[]}} exits populated with employee
 */
const listMyClearances = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  // Clearance sections are assigned per person rather than laddered, so the
  // Backend's "everything" view is every section still open, not only its own.
  const all = seesAllApprovals(req.user);
  const filter = scope === 'history'
    ? (all ? { clearanceSections: { $exists: true, $ne: [] } } : { 'clearanceSections.assignedTo': me })
    : {
      status: 'InClearance',
      clearanceSections: { $elemMatch: all ? { completed: false } : { assignedTo: me, completed: false } },
    };
  const requests = await ExitRequest.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user designation department',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ lastWorkingDay: 1 });
  // The company items each leaver still holds, so the manager collecting them
  // sees "Laptop — MacBook i5 (SN …)" rather than just the word "Laptop" on
  // their checklist. One query for the whole page.
  const userIds = requests.map((r) => r.employee?.user?._id).filter(Boolean);
  const held = await openHoldingsFor(userIds);
  const byUser = new Map();
  for (const h of held) {
    const k = String(h.employee);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push({
      _id: h._id, name: h.asset?.name, category: h.asset?.category, details: h.details,
      serialNumber: h.serialNumber, unitTag: h.unitTag, assignedAt: h.assignedAt,
    });
  }
  const out = requests.map((r) => ({
    ...r.toObject(),
    heldAssets: byUser.get(String(r.employee?.user?._id)) || [],
  }));
  res.json({ scope, count: out.length, requests: out });
});

// ================= Attendance regularizations (configured ladder) =================
// Only requests whose employee has SuperAdmin-configured approvers reach here —
// an unconfigured one has no chain and stays on the flat HR-review path.

/**
 * List regularizations for the current approver.
 * @route GET /api/approvals/regularizations?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (awaiting me) or 'history' (any chain I'm in)
 * @returns {{scope, count, requests: Object[]}}
 */
/**
 * The regularization inbox filter — the chain rungs, PLUS HR's final rung.
 *
 * HR is the last rung of every ladder, but not a NAMED one: a cleared request
 * carries no `currentApprover`, so the chain filter finds none of them and HR's
 * own turn was invisible here — they had to go to the Regularizations tab to
 * find work the inbox had told them about. This adds that queue for anyone who
 * can actually decide it.
 *
 * TWO THINGS IT MUST NOT SKIP. The company wall (the chain half needs none —
 * a named approver was picked explicitly — but "every request waiting on HR" is
 * a fan-out, and without the wall it spans companies). And the SuperAdmin, who
 * already matches every Pending request through `seesAllApprovals`; $or-ing a
 * second clause onto that would only duplicate rows.
 * @param {import('express').Request} req
 * @param {'pending'|'history'} scope
 * @returns {Promise<Object>} a Mongo filter
 */
async function regularizationInboxFilter(req, scope) {
  const base = chainInboxFilter(req.user, scope);
  if (scope !== 'pending' || seesAllApprovals(req.user) || !hasPermission(req.user, 'attendance.manage')) {
    return base;
  }
  const hrQueue = { ...AWAITING_HR };
  await scopeUserField(req, hrQueue); // Regularization.employee is a User id
  return { $or: [base, hrQueue] };
}

const listMyRegularizationApprovals = asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const filter = await regularizationInboxFilter(req, scope);
  const requests = await Regularization.find(filter)
    .populate('employee', 'firstName lastName email role')
    .sort({ date: -1 })
    .lean();

  // Attach the day's CURRENT punches so the approver sees "from → to" rather
  // than only the value being asked for. previousCheckIn/Out on the request
  // itself are no help here: applyToAttendance fills those at approval time, so
  // a pending request has them empty — which is exactly when the approver needs
  // to know what is being changed.
  const withCurrent = await attachCurrentPunches(requests);
  // Which rung each row is at, stamped rather than re-derived on the client —
  // the same field name the module's own list endpoints use, so one rule about
  // "is this HR's turn" reaches every screen that draws these requests.
  res.json({
    scope,
    count: withCurrent.length,
    requests: withCurrent.map((r) => ({ ...r, awaitingHr: r.status === 'Pending' && !r.currentApprover })),
  });
});

/**
 * Look up the attendance record behind each regularization and hang the current
 * punches off it as `current: { checkIn, checkOut, status }`.
 *
 * Regularization.employee refs User while Attendance.employee refs
 * EmployeeProfile, so this hops through the profile. Two queries for the whole
 * page rather than one per row; a day with no record simply comes back null.
 * @param {Object[]} requests - lean Regularization docs
 * @returns {Promise<Object[]>} the same docs, each with `current`
 */
async function attachCurrentPunches(requests) {
  if (!requests.length) return requests;
  const EmployeeProfile = require('../models/EmployeeProfile');
  const Attendance = require('../models/Attendance');
  const { startOfDayIST } = require('../utils/dateHelpers');

  const userIds = [...new Set(requests.map((r) => String(r.employee?._id || r.employee)).filter(Boolean))];
  const profiles = await EmployeeProfile.find({ user: { $in: userIds } }).select('user').lean();
  const profByUser = new Map(profiles.map((p) => [String(p.user), String(p._id)]));

  const pairs = requests
    .map((r) => ({
      profileId: profByUser.get(String(r.employee?._id || r.employee)),
      day: startOfDayIST(r.date),
    }))
    .filter((p) => p.profileId);
  // An empty $or is a Mongo error, so bail before building the query.
  if (!pairs.length) return requests.map((r) => ({ ...r, current: null }));

  const records = await Attendance.find({
    $or: pairs.map((p) => ({ employee: p.profileId, date: p.day })),
  }).select('employee date checkIn checkOut status').lean();

  const key = (empId, day) => `${empId}|${new Date(day).getTime()}`;
  const byKey = new Map(records.map((a) => [key(String(a.employee), a.date), a]));

  return requests.map((r) => {
    const profileId = profByUser.get(String(r.employee?._id || r.employee));
    const found = profileId ? byKey.get(key(profileId, startOfDayIST(r.date))) : null;
    return {
      ...r,
      current: found
        ? { checkIn: found.checkIn || null, checkOut: found.checkOut || null, status: found.status || null }
        : null,
    };
  });
}

// Shared by the approve/reject routes below — both are the same call with a
// different action.
//
// WHICH RUNG is being decided decides which function runs, and the item itself
// answers that: one with a `currentApprover` is at a NAMED rung, scoped to
// `currentApprover === me` inside advanceRegularizationApproval; one without is
// at HR's final rung, and goes through the same decideAsHr the Regularizations
// tab uses — including its refusals (your own request, an HR's own correction, a
// view-only exec). Routing it to advance instead would have answered HR with
// "this regularization is not awaiting your approval", since a null
// currentApprover reads there as an override only a SuperAdmin may make.
const decideRegularization = (action) =>
  asyncHandler(async (req, res) => {
    const item = await Regularization.findById(req.params.id);
    if (!item) {
      res.status(404);
      throw new Error('Regularization request not found');
    }
    try {
      // A SuperAdmin keeps the advance path even on a cleared request: it is
      // their documented override, and it finalises and applies exactly as it
      // did before HR became a rung.
      const hrRung = !item.currentApprover && req.user.role !== 'SuperAdmin';
      const out = hrRung
        ? await decideAsHr(item, req.user, action === 'approve' ? 'Approved' : 'Rejected', req.body.note)
        : await advanceRegularizationApproval(item, req.user._id, action, req.body.note, req.user);
      res.json(out);
    } catch (err) {
      res.status(err.status || 400);
      throw err;
    }
  });

/**
 * Approve a regularization at the current chain step (may advance or finalise+apply).
 * @route PATCH /api/approvals/regularizations/:id/approve
 */
const approveRegularization = decideRegularization('approve');

/**
 * Reject a regularization at the current chain step (stops the chain).
 * @route PATCH /api/approvals/regularizations/:id/reject
 */
const rejectRegularization = decideRegularization('reject');

// ============ Work on a leave day (punched in while on approved leave) ============
// Not a ladder: the whole leave hierarchy already granted the leave, so only its
// TOP rung rules on whether working through it counts. The claim lives on the
// attendance record itself (Attendance.workOnLeave), so these are days, not
// requests. Scoping is `workOnLeave.approver === me`, enforced again inside
// decideWorkOnLeave, which also honours an HR (`leave.manage`) override.

/**
 * List work-on-leave claims for the current approver.
 * @route GET /api/approvals/work-on-leave?scope=pending|history
 * @param {string} [req.query.scope] - 'pending' (awaiting me) or 'history' (every claim routed to me)
 * @returns {{scope, count, claims: Object[]}}
 */
const listMyWorkOnLeave = asyncHandler(async (req, res) => {
  const scope = req.query.scope === 'history' ? 'history' : 'pending';
  const claims = await listWorkOnLeaveClaims(req.user._id, scope, seesAllApprovals(req.user));
  res.json({ scope, count: claims.length, claims });
});

// Shared by the approve/reject routes — the same call with a different action.
const decideWorkOnLeaveRoute = (action) =>
  asyncHandler(async (req, res) => {
    const record = await Attendance.findById(req.params.id);
    if (!record) {
      res.status(404);
      throw new Error('Attendance record not found');
    }
    try {
      const out = await decideWorkOnLeave(record, req.user._id, action, req.body.note, req.user);
      res.json({ record: out.record, leaveDayReturned: out.leaveDayReturned });
    } catch (err) {
      res.status(err.status || 400);
      throw err;
    }
  });

/**
 * Approve a punch-in made on an approved-leave day: the leave day is returned
 * and the day becomes a worked day.
 * @route PATCH /api/approvals/work-on-leave/:id/approve
 */
const approveWorkOnLeave = decideWorkOnLeaveRoute('approve');

/**
 * Reject it: the punches stay on the record, the day stays leave.
 * @route PATCH /api/approvals/work-on-leave/:id/reject
 */
const rejectWorkOnLeave = decideWorkOnLeaveRoute('reject');

/**
 * How many items are waiting on the current user, for the top-bar shortcut badge.
 *
 * Deliberately cheap — three countDocuments, no populate and no chain healing —
 * because every logged-in user's top bar polls this on a timer, whereas the list
 * endpoints above each run healOrphanChains() and fully populate their results.
 * The trade-off: a legacy request whose chain was never built (currentApprover
 * null) is not counted here until an inbox load heals it.
 * @route GET /api/approvals/count
 * @returns {{leave, emergencyLeave, exits, clearances, regularizations,
 *   workOnLeave, interviews, total}} — `emergencyLeave` is days already taken
 *   awaiting a confirm/reject, counted separately from `leave` because they are
 *   not the same kind of waiting. `interviews` is NOT an approval and is
 *   deliberately OUTSIDE `total` — see below.
 */
const countMyApprovals = asyncHandler(async (req, res) => {
  const me = req.user._id;
  // The badge has to agree with the lists above, or the Backend sees a count of
  // 3 and opens an inbox holding 11.
  const all = seesAllApprovals(req.user);
  const mine = all ? {} : { currentApprover: me };
  const section = all ? { completed: false } : { assignedTo: me, completed: false };
  // Leave has its own, wider rule (an executive sees the company's, not their
  // rung's), and the badge has to be counted with exactly the filter the list
  // uses or the tab says 3 and opens on 11.
  const allLeave = seesAllLeave(req.user);
  const leaveFilter = allLeave
    ? await scopeEmployeeFilter(req, { status: 'Pending' })
    : { ...mine, status: 'Pending' };
  const emergencyFilter = allLeave
    ? await scopeEmployeeFilter(req, emergencyReviewFilter(req.user))
    : emergencyReviewFilter(req.user);
  const [
    leave, emergencyLeave, exits, clearances, regularizations, workOnLeave, interviews,
    taskApproval, salaryChange,
  ] = await Promise.all([
    LeaveRequest.countDocuments(leaveFilter),
    // Its own tally, never folded into `leave`: these are days already taken,
    // waiting only on somebody agreeing they should have been. Same filter the
    // list uses, so the badge and the queue cannot disagree.
    LeaveRequest.countDocuments(emergencyFilter),
    ExitRequest.countDocuments({ ...mine, status: 'Pending' }),
    ExitRequest.countDocuments({
      status: 'InClearance',
      clearanceSections: { $elemMatch: section },
    }),
    Regularization.countDocuments({ ...mine, status: 'Pending' }),
    Attendance.countDocuments({
      ...(all ? {} : { 'workOnLeave.approver': me }), 'workOnLeave.status': 'Pending',
    }),
    // Interview rounds booked with this person and not yet written up. Counted
    // here because this route IS the "waiting on you personally" tally and it is
    // already polled by every signed-in user — a second endpoint would be a
    // second request every twenty seconds for one number.
    //
    // ALWAYS `me`, never widened by `all`: sitting at the top of every approval
    // chain does not put somebody else's interview in your diary.
    //
    // `$nin` rather than `$in: ['Pending','Scheduled']`, to match the page
    // exactly (EmployeeInterviews splits on DECIDED = Cleared|Rejected). A round
    // whose status was never set is shown there as Pending, so it has to be
    // counted here too — `$in` would silently miss it.
    Candidate.countDocuments({
      rounds: { $elemMatch: { interviewer: me, status: { $nin: ['Cleared', 'Rejected'] } } },
    }),
    // Tasks on this person right now, plus submissions waiting on their word.
    //
    // ANSWERED HERE AS OF 2026-09-22, because it belongs here: it is "what is
    // waiting on you", counted from your own rows, and it has nothing to do
    // with the HR-wide tally that used to be its only home. That mattered the
    // moment the top bar got a Tasks pill for EVERYONE — /approvals/hr-count is
    // deliberately not called in My Portal (see navCountsStore), so an employee
    // would have worn a badge that could only ever read 0.
    //
    // hr-count still answers it as well, and deliberately: an Android build
    // already in somebody's pocket reads the key from there, and an APK does
    // not update because the server did. Same reasoning as the legacy subtask
    // routes. Both call this one helper, so the two answers cannot drift.
    countMyOpenTasks(req).catch(() => 0),
    // Salary changes an HR raised, waiting on a CEO/MD/Super Admin — 0 for
    // everyone else (services/salaryChanges.js). Addressed to the executive
    // bench as surely as a leave at the top of its ladder is.
    countPendingSalaryChanges(req).catch(() => 0),
  ]);
  res.json({
    leave,
    emergencyLeave,
    exits,
    clearances,
    regularizations,
    workOnLeave,
    interviews,
    taskApproval,
    // Deliberately OUTSIDE `total` for now: the Android app wears `total` on an
    // Approvals screen that has no salary tab yet, and a count that opens on
    // nothing is the thing this endpoint promises never to show. The web client
    // adds it to its own Approvals pill, where the Approvals page does list it.
    salaryChange,
    // OUTSIDE the total, deliberately — both of them. `total` is what the
    // Approvals pill wears, and neither an interview nor a task is something you
    // approve there: folding either in would put a number on a badge that opens
    // an inbox not holding it. Each is worn by its own pill instead.
    total: leave + emergencyLeave + exits + clearances + regularizations + workOnLeave,
  });
});

/**
 * How many items sit in the HR-WIDE approvals inbox — the category tabs of
 * the admin Approvals screen (mobile: screens/admin/ApprovalsScreen). Feeds the
 * count badge on the menu row and the console tile that open it, so a queue can
 * announce itself without being opened.
 *
 * Distinct from countMyApprovals above, which counts the REPORTING-CHAIN inbox
 * (things addressed to you personally). The two are different queues and their
 * two badges deliberately show different numbers.
 *
 * WHY ONE QUERY PER CATEGORY AND NOT ONE FOR ALL. Each category is a different collection behind a
 * different capability and a different slice of the company wall. So each tally
 * is built with the SAME gate and the SAME scope helper its own list route uses —
 * named in the comment on each line — rather than with one invented filter that
 * would quietly drift from what the screen actually lists. A category the caller
 * may not see counts 0, never 403: the client fetches them all and swallows
 * failures already, and a badge must never break the menu it sits in.
 *
 * The keys are mobile ApprovalsScreen's CATEGORIES[].key, so the entry badge and
 * that screen's per-tab badges cannot disagree about which number is which.
 * @route GET /api/approvals/hr-count
 * @returns {{leave:number, expense:number, travel:number, regularization:number,
 *   loan:number, change:number, docswap:number, total:number}}
 */
const countHrApprovals = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const may = (cap) => hasPermission(req.user, cap);
  const NONE = Promise.resolve(0);

  // GET /leave/requests?status=Pending        (leave.manage)      employee = EmployeeProfile
  // Counted for an EXECUTIVE too, on the same company wall. They have always
  // been able to read that list (a portal viewer passes every capability guard
  // on a GET), and they can now decide from it — so a badge that stayed at 0
  // while the tab held eleven requests was telling them the opposite of the
  // truth. Same shape as the document-swap count below.
  const leaveQ = may('leave.manage') || isExecViewer(req.user)
    ? LeaveRequest.countDocuments(await scopeEmployeeFilter(req, { status: 'Pending' }))
    : NONE;
  // GET /expenses?status=Pending              (expenses.manage)   employee = User
  const expenseQ = may('expenses.manage')
    ? Expense.countDocuments(await scopeUserField(req, { status: 'Pending' }))
    : NONE;
  // GET /travel?status=Pending                (travel.manage)     employee = User
  const travelQ = may('travel.manage')
    ? TravelRequest.countDocuments(await scopeUserField(req, { status: 'Pending' }))
    : NONE;
  // GET /regularizations?status=Pending       (attendance.manage) employee = User
  // `currentApprover: null` is the "it is HR's turn" half of Pending: a request
  // still climbing its configured ladder carries its approver's id and is not
  // HR's to decide yet. Without it HR's badge counts other people's queues, and
  // a badge you cannot clear is one people stop reading. (Also matches the
  // documents that predate the field, which were always HR's.)
  const regularizationQ = may('attendance.manage')
    ? Regularization.countDocuments(await scopeUserField(req, { ...AWAITING_HR }))
    : NONE;
  // GET /loans?status=Pending                 (loans.manage)      employee = User
  const loanQ = may('loans.manage')
    ? Loan.countDocuments(await scopeUserField(req, { status: 'Pending' }))
    : NONE;
  // GET /change-requests/assigned             (CHANGE_INBOX_ROLES, mine only —
  // the client never sends ?all=true, so neither does this).
  const changeQ = CHANGE_INBOX_ROLES.includes(req.user.role)
    ? ChangeRequest.countDocuments({ assignedTo: me, status: 'pending' })
    : NONE;
  // GET /documents/replace-requests/assigned  (canReadOthersDocs). An exec is
  // never anybody's assigned HR partner, so "assigned to me" would always be 0
  // for them — their view is every request inside their company wall instead.
  const docswapQ = canReadOthersDocs(req.user)
    ? DocumentChangeRequest.countDocuments(
      isPortalViewer(req.user)
        ? await scopeEmployeeFilter(req, { status: 'pending' })
        : { assignedTo: me, status: 'pending' }
    )
    : NONE;

  // GET /payroll/self-approvals              (CEO/MD/SuperAdmin) employee = EmployeeProfile
  // A payslip its own subject prepared, frozen until an executive sanctions it.
  // Role-gated rather than capability-gated on purpose: `payroll.manage` is held
  // by the very HR Manager being judged, so counting on it would put the item in
  // their own inbox (see authMiddleware.canApproveSelfPayslip).
  const selfPayslipQ = canApproveSelfPayslip(req.user)
    ? Payroll.countDocuments(await scopeEmployeeFilter(req, { 'selfApproval.status': 'Pending' }))
    : NONE;

  // GET /khata/pending                       (khata.manage)       employee = User
  // The Approvals tab's own list: an advance to pay out, a settlement to pay
  // back, or a payout somebody raised above their operator limit.
  const khataQ = may('khata.manage')
    ? KhataEntry.countDocuments(await scopeUserField(req, { status: 'Pending' }))
    : NONE;
  // GET /khata/entries?movement=expense,refund&status=Approved&confirmed=false
  //                                           (khata.manage)       employee = User
  // THE OTHER HALF OF THE SAME TAB, and a different query — which is exactly why
  // it is counted separately instead of being assumed. "Expenses and refunds to
  // confirm" is money the employee has ALREADY spent against their advance: it
  // posted on the spot (holding it only made the wallet lie about what was
  // left), so it is Approved, not Pending, and what is waiting is somebody
  // checking it. `$ne: true` and not `false`, because rows written before the
  // flag existed carry no `confirmedByCompany` at all — same test listEntries
  // makes for `?confirmed=false`.
  const khataConfirmQ = may('khata.manage')
    ? KhataEntry.countDocuments(await scopeUserField(req, {
      movement: { $in: ['expense', 'refund'] },
      status: 'Approved',
      confirmedByCompany: { $ne: true },
    }))
    : NONE;
  // GET /khata/advance-approvals              (canApproveAdvances)  employee = User
  // The other queue on the SAME page, behind a different gate: an advance an
  // employee has asked for, waiting on a CEO/MD/Super Admin to sanction it. Kept
  // a separate key because the two audiences barely overlap — an executive holds
  // no khata capability, and the operators who confirm expenses cannot sanction.
  // The sidebar row adds them up; the page keeps them on their own tabs.
  const khataSanctionQ = canApproveAdvances(req.user)
    ? KhataEntry.countDocuments(await scopeUserField(req, { status: 'AwaitingApproval' }))
    : NONE;
  // GET /cashbook/entries?status=Pending      (cashbook.manage)     walled by ACCOUNT
  // Petty-cash vouchers staff have filed, waiting on finance to post them.
  // `scopeEntryAccounts`, not a people wall: a cashbook entry belongs to a cash
  // account, and which accounts an operator may touch is its own list.
  const voucherQ = may('cashbook.manage')
    ? CashbookEntry.countDocuments(await scopeEntryAccounts(req, { status: 'Pending' }))
    : NONE;
  // GET /exits?status=Pending                 (exit.manage)        employee = EmployeeProfile
  // Resignations nobody has decided. Deliberately NOT the InClearance ones as
  // well: a notice period legitimately runs for a month, and a badge that cannot
  // be cleared for a month is a badge people stop reading.
  const exitQ = may('exit.manage')
    ? ExitRequest.countDocuments(await scopeEmployeeFilter(req, { status: 'Pending' }))
    : NONE;
  // GET /complaints/assigned                  (leadership roles)   complainant = User
  // Counted by the complaints controller itself, from the same filter its inbox
  // uses — including the rule that nobody sees a complaint raised against them.
  const complaintQ = countOpenComplaints(req).catch(() => 0);
  // GET /password-reset-requests              (users.manage)       walled in JS
  // Its wall cannot be written as a Mongo filter (a request is keyed by the
  // address somebody typed, not by an account), so its own controller counts it.
  const passwordResetQ = may('users.manage')
    ? countOpenResetRequests(req).catch(() => 0)
    : NONE;
  // GET /declarations?status=Submitted        (declarations.manage) employee = User
  const declarationQ = may('declarations.manage')
    ? InvestmentDeclaration.countDocuments(await scopeUserField(req, { status: 'Submitted' }))
    : NONE;
  // GET /courses/enrollments/pending + the two moderation queues (courses.manage)
  // THREE QUERIES, ONE NUMBER, because they are one job and one screen: somebody
  // asking to join a course, an issue reported against one, and a comment
  // awaiting moderation. They are not company-walled — neither are the lists
  // they badge (a course is org-wide), so the badge matches what opens.
  const courseQ = may('courses.manage')
    ? Promise.all([
      Enrollment.countDocuments({ approvalStatus: 'Pending' }),
      CourseReport.countDocuments({ status: 'Open' }),
      CourseComment.countDocuments({ status: 'Pending' }),
    ]).then(([a, b, c]) => a + b + c).catch(() => 0)
    : NONE;
  // GET /lifecycle/confirmations              (lifecycle.manage)   EmployeeProfile
  // Probations landing inside the next 30 days, or already past. NOT a
  // countDocuments: the due date is not stored — it is `confirmationDueDate` OR
  // joining + probation months — so rebuilding it in an aggregation would give a
  // second answer for free (Mongo clamps 31 Jan + 1 month to 28 Feb, JS rolls it
  // to 3 March). Its own controller evaluates the one rule the list uses.
  const confirmationQ = may('lifecycle.manage')
    ? countDueConfirmations(req).catch(() => 0)
    : NONE;
  // GET /tasks?scope=mine                     (nobody — a personal list)
  // No capability gate on purpose: everybody has tasks. Since the 2026-09-21
  // rework a task has no approval step, so what this badge counts is what is
  // ON somebody — their open tasks, overdue ones included. The key is still
  // `taskApproval` because the sidebar and the app's hub read it by that name;
  // renaming it would be a three-repo change for a word.
  const taskApprovalQ = countMyOpenTasks(req).catch(() => 0);

  // GET /payroll?releaseStatus=Requested,Approved,ChangeRequested  (payroll.manage)
  // The "Needs action" tab of Payslip Requests: an employee has asked for a
  // slip and it is not in their hands yet. The three states are HR's three
  // steps (check, finalise, re-finalise after a query), which is why they count
  // as one number rather than three — the badge answers "is there payslip work
  // waiting", and the tab it opens shows which kind.
  //
  // The list route also adds back the operator's OWN payslips regardless of
  // scope (includeOwnPayslips); the badge does not, so an HR looking at a
  // request they filed themselves sees it in the queue without it inflating the
  // count of other people's work.
  const payslipRequestQ = may('payroll.manage')
    ? Payroll.countDocuments(await scopeEmployeeFilter(req, {
      'release.status': { $in: ['Requested', 'Approved', 'ChangeRequested'] },
    }))
    : NONE;

  // GET /assets/return-requests                (assets.manage)      employee = User
  // Items their holders asked to hand back; badges the Assets row.
  const assetReturnQ = may('assets.manage')
    ? AssetAssignment.countDocuments(await scopeUserField(req, { 'returnRequest.status': 'Pending', returnedAt: null }))
    : NONE;

  // GET /recruitment/consultancy/job-requests  (canDecideJobRequests)  walled by company
  // Openings an outside HR consultancy asked for, waiting on HR / a CEO / MD /
  // the Backend to accept or reject. Counted by its own controller with the
  // decision gate its approve route uses — 0 for anybody who could only read
  // them — so the number on the sidebar row is always one the reader can clear.
  const jobRequestQ = countPendingJobRequests(req).catch(() => 0);

  // GET /payroll/salary-changes?status=Pending   (CEO/MD/SuperAdmin decide)
  // Salary changes an HR asked for. 0 for anyone who cannot decide one — HR's
  // own requests wait on somebody else. The app's Approvals screen has a tab
  // for it from 2.8.36 (keyed 'salary', like mobile ApprovalsScreen's CATEGORIES).
  const salaryQ = countPendingSalaryChanges(req).catch(() => 0);

  const [leave, expense, travel, regularization, loan, change, docswap, selfPayslip,
    payslipRequest, khata, khataConfirm, khataSanction, voucher, exit, complaint,
    passwordReset, declaration, course, confirmation, taskApproval, assetReturn, jobRequest,
    salary] = await Promise.all([
    leaveQ, expenseQ, travelQ, regularizationQ, loanQ, changeQ, docswapQ, selfPayslipQ,
    payslipRequestQ, khataQ, khataConfirmQ, khataSanctionQ, voucherQ, exitQ, complaintQ,
    passwordResetQ, declarationQ, courseQ, confirmationQ, taskApprovalQ, assetReturnQ, jobRequestQ,
    salaryQ,
  ]);
  res.json({
    leave,
    expense,
    travel,
    regularization,
    loan,
    change,
    docswap,
    selfPayslip,
    payslipRequest,
    khata,
    khataConfirm,
    khataSanction,
    voucher,
    exit,
    complaint,
    passwordReset,
    declaration,
    course,
    confirmation,
    taskApproval,
    assetReturn,
    jobRequest,
    // OUTSIDE `total`, like everything after selfPayslip — but for a different
    // reason: the Approvals screen of app builds before 2.8.36 has no salary
    // tab, and they wear `total`. Newer builds add it to their own badge.
    salary,
    // `total` is the APPROVALS SCREEN's tally and deliberately counts only the
    // categories that screen lists. Everything added after `selfPayslip` badges
    // its own module in the sidebar instead, so folding it in here would badge
    // the Approvals screen with work it cannot show — a number that opens on
    // nothing.
    total: leave + expense + travel + regularization + loan + change + docswap + selfPayslip,
  });
});

/**
 * The assigned manager ticks their no-dues section and, with `submit`, signs it
 * off with optional remarks for HR.
 * @route PATCH /api/approvals/clearances/:id/:key
 * @param {Object} req.body.items - array of { done, note } by item index
 * @param {string} [req.body.remarks] - the manager's note to HR (omitted = unchanged)
 * @param {boolean} [req.body.submit] - stamp the section as submitted and tell HR
 * @returns {{request: Object}}
 */
const updateMyClearanceSection = asyncHandler(async (req, res) => {
  const request = await ExitRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    // privileged=false → the actor must be the section's assignee.
    await recordClearanceSection(request, req.params.key, req.user._id, false, req.body);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

module.exports = {
  listMyLeaveApprovals,
  approveLeave,
  rejectLeave,
  listMyExitApprovals,
  approveExit,
  rejectExit,
  listMyClearances,
  updateMyClearanceSection,
  countMyApprovals,
  countHrApprovals,
  listMyRegularizationApprovals,
  approveRegularization,
  rejectRegularization,
  listMyWorkOnLeave,
  approveWorkOnLeave,
  rejectWorkOnLeave,
};
