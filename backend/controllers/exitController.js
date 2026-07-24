/**
 * Exit controller — the resignation/exit lifecycle on ExitRequest. Resignations
 * climb the reporting-hierarchy approval ladder (shared with leave) into a notice
 * period (InClearance, login still active), then a manual/worker finalize step
 * stamps dateOfExit, disables the login, and issues a public exit-feedback link.
 * Also exposes HR admin CRUD, employee self-service, and the public feedback API.
 * Several helpers (advanceExitApproval, ensureExitApprovalChain, finalizeExit) are
 * exported for the approvals controller and the notice-period worker.
 */
const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const ExitRequest = require('../models/ExitRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { enqueueMail } = require('../services/email');
const { buildExitEmail } = require('../services/exitEmails');
const { notify } = require('../services/notify');
const { buildApprovalChain } = require('./leaveController');
const { startOfDayIST } = require('../utils/dateHelpers');
const { buildDefaultSections } = require('../config/exitClearance');

const APP_BASE_URL = () => process.env.APP_BASE_URL || 'http://localhost:5173';
const FEEDBACK_TTL_DAYS = 60;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const fmtD = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';

// Calendar days from the resignation/submission date to the last working day
// (anchored to the IST calendar day). This is the SINGLE source of truth for
// noticePeriodDays, so the two fields can never disagree. Never negative.
function deriveNoticeDays(from, lastWorkingDay) {
  if (!from || !lastWorkingDay) return 0;
  const a = startOfDayIST(from).getTime();
  const b = startOfDayIST(lastWorkingDay).getTime();
  const days = Math.round((b - a) / 86400000);
  return days > 0 ? days : 0;
}

// Resolve an applicant's display name from a profile (populated or not), an
// EmployeeProfile id, or an ObjectId.
async function applicantNameOf(profileOrId) {
  let prof = profileOrId;
  if (!prof || !prof.user || !prof.user.firstName) {
    const id = prof?._id || prof;
    prof = await EmployeeProfile.findById(id).select('user').populate('user', 'firstName lastName');
  }
  return `${prof?.user?.firstName || ''} ${prof?.user?.lastName || ''}`.trim() || 'An employee';
}

// ---- Exit notifications (best-effort; never block the request) ----

// The approver whose turn it is now. audience 'all' because the approver may be
// a plain Manager working in My Portal or an exec/HR in the Admin portal.
async function notifyExitApprover(approverUserId, exit, applicantName) {
  try {
    await notify({
      recipient: approverUserId,
      type: 'exit',
      audience: 'all',
      title: 'Resignation needs your approval',
      body: `${applicantName} submitted a resignation (last working day ${fmtD(exit.lastWorkingDay)}) — it's awaiting your approval.`,
      link: '/employee/approvals',
    });
  } catch (err) {
    console.error('exit approver notify failed:', err.message);
  }
}

// Tell the employee their resignation was accepted (into notice) or declined.
async function notifyEmployeeExitDecision(exit, accepted, note) {
  try {
    const prof = await EmployeeProfile.findById(exit.employee).select('user');
    if (!prof?.user) return;
    await notify({
      recipient: prof.user,
      type: 'exit',
      audience: 'employee',
      title: accepted ? 'Resignation accepted' : 'Resignation declined',
      body: accepted
        ? `Your resignation has been accepted. You're serving notice until ${fmtD(exit.lastWorkingDay)}.${note ? ` Note: ${note}` : ''}`
        : `Your resignation request was declined.${note ? ` Note: ${note}` : ''}`,
      link: '/employee/exit',
    });
  } catch (err) {
    console.error('exit decision notify failed:', err.message);
  }
}

// Resolve the HR owner for an exit: handledBy → employee's hrPartner → a SuperAdmin.
async function resolveHrRecipient(exit) {
  if (exit.handledBy) return exit.handledBy;
  const prof = await EmployeeProfile.findById(exit.employee).select('hrPartner');
  if (prof?.hrPartner) return prof.hrPartner;
  const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
  return sa?._id || null;
}

// Once accepted, ask HR to run the clearance formalities before release.
async function notifyHrBeginClearance(exit, applicantName) {
  try {
    const hrId = await resolveHrRecipient(exit);
    if (!hrId) return;
    await notify({
      recipient: hrId,
      type: 'exit',
      audience: 'admin',
      title: 'Exit accepted — begin clearance',
      body: `${applicantName}'s resignation was approved. Notice ends ${fmtD(exit.lastWorkingDay)}. Complete the clearance checklist before the account is released.`,
      link: '/admin/exits',
    });
  } catch (err) {
    console.error('exit HR-clearance notify failed:', err.message);
  }
}

// No reporting manager in the chain — HR decides via the Exit console.
async function notifyHrExitReview(exit, applicantName) {
  try {
    const hrId = await resolveHrRecipient(exit);
    if (!hrId) return;
    await notify({
      recipient: hrId,
      type: 'exit',
      audience: 'admin',
      title: 'Resignation needs review',
      body: `${applicantName} submitted a resignation (last working day ${fmtD(exit.lastWorkingDay)}) but has no reporting manager — please review in the Exit console.`,
      link: '/admin/exits',
    });
  } catch (err) {
    console.error('exit HR review notify failed:', err.message);
  }
}

// ---- Approval ladder (shared shape with Leave) ----

// Build the reporting-hierarchy chain for a resignation, mark the first rung
// pending, and ping the first approver. Empty chain (no manager) → HR reviews.
async function initResignationApproval(exit, profile, applicantName) {
  const chain = await buildApprovalChain(profile);
  if (chain.length) {
    chain[0].status = 'Pending';
    exit.approvalChain = chain;
    exit.currentApprover = chain[0].approver;
    await exit.save();
    await notifyExitApprover(chain[0].approver, exit, applicantName);
  } else {
    await notifyHrExitReview(exit, applicantName);
  }
  return exit;
}

// Hierarchy step decision for a resignation. The acting user MUST be the current
// approver. Approve → advance to the next rung, or (top rung) accept into the
// notice period (status 'InClearance', login stays active). Reject → 'Cancelled'
// with the note. Mutates + saves; throws Error with `.status` on a bad transition.
async function advanceExitApproval(exit, userId, action, note) {
  if (exit.status !== 'Pending') {
    const err = new Error(`Cannot ${action} — this exit is ${exit.status}.`);
    err.status = 400;
    throw err;
  }
  if (!exit.currentApprover || String(exit.currentApprover) !== String(userId)) {
    const err = new Error('This resignation is not awaiting your approval.');
    err.status = 403;
    throw err;
  }
  const now = new Date();
  const step = (exit.approvalChain || []).find(
    (s) => String(s.approver) === String(userId) && s.status === 'Pending'
  );

  if (action === 'reject') {
    if (step) { step.status = 'Rejected'; step.decidedAt = now; step.note = note; }
    for (const s of exit.approvalChain || []) {
      if (s.status === 'Waiting') s.status = 'Skipped';
    }
    exit.status = 'Cancelled';
    exit.currentApprover = null;
    exit.approver = userId;
    exit.decisionAt = now;
    exit.decisionNote = note;
    exit.cancelledAt = now;
    exit.cancellationReason = note;
    await exit.save();
    await notifyEmployeeExitDecision(exit, false, note);
    return exit;
  }

  // Approve — is there a rung above me still waiting?
  const next = (exit.approvalChain || []).find(
    (s) => s.status === 'Waiting' && (!step || s.order > step.order)
  );
  if (next) {
    if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
    next.status = 'Pending';
    exit.currentApprover = next.approver;
    await exit.save();
    await notifyExitApprover(next.approver, exit, await applicantNameOf(exit.employee));
    return exit;
  }

  // Top rung — accept the resignation into the notice period.
  if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
  exit.status = 'InClearance';
  exit.currentApprover = null;
  exit.approver = userId;
  exit.decisionAt = now;
  exit.decisionNote = note;
  await exit.save();
  const name = await applicantNameOf(exit.employee);
  await notifyEmployeeExitDecision(exit, true, note);
  await notifyHrBeginClearance(exit, name);
  await notifyAssignedSections(exit, name);
  return exit;
}

// Self-heal a Pending resignation that has no chain yet (created before this
// feature, or with no manager at submit time). Idempotent. Returns true if healed.
async function ensureExitApprovalChain(exit) {
  if (!exit || exit.status !== 'Pending' || exit.type !== 'Resignation') return false;
  if (exit.currentApprover || (exit.approvalChain && exit.approvalChain.length)) return false;
  const profile = await EmployeeProfile.findById(exit.employee)
    .select('user reportingManager')
    .populate('user', 'firstName lastName');
  if (!profile) return false;
  const chain = await buildApprovalChain(profile);
  if (!chain.length) return false;
  chain[0].status = 'Pending';
  exit.approvalChain = chain;
  exit.currentApprover = chain[0].approver;
  await exit.save();
  try {
    await notifyExitApprover(chain[0].approver, exit, await applicantNameOf(profile));
  } catch (err) {
    console.error('ensureExitApprovalChain notify failed:', err.message);
  }
  return true;
}

// Deactivation core shared by the manual "Complete Exit" action and the exit
// worker: stamp dateOfExit, disable the login, move to Completed, ensure a
// feedback token exists. Expects `exit` populated with employee + employee.user.
async function finalizeExit(exit) {
  if (!exit.feedbackToken) {
    exit.feedbackToken = generateToken();
    exit.feedbackTokenExpiresAt = new Date(Date.now() + FEEDBACK_TTL_DAYS * 86400 * 1000);
  }
  const profile = exit.employee;
  profile.dateOfExit = exit.lastWorkingDay;
  await profile.save();
  if (profile.user) {
    profile.user.isActive = false;
    await profile.user.save();
  }
  exit.status = 'Completed';
  exit.completedAt = new Date();
  await exit.save();
}

// ---- No-dues clearance sections ----

// A section is complete when every one of its items is ticked.
function sectionItemsDone(section) {
  const items = section?.items || [];
  return items.length > 0 && items.every((it) => !!it.done);
}

// Recompute the `completed` flag on a section from its items, stamping who/when.
function recomputeSection(section, userId) {
  const done = sectionItemsDone(section);
  if (done && !section.completed) {
    section.completed = true;
    section.completedAt = new Date();
    if (userId) section.completedBy = userId;
  } else if (!done && section.completed) {
    section.completed = false;
    section.completedAt = undefined;
    section.completedBy = undefined;
  }
  return section;
}

// Whether the no-dues gate is satisfied: an HR override, or every seeded section
// completed. Exits created before this feature (no sections) fall back to the
// legacy flat clearance so they can still be closed.
function clearanceSatisfied(exit) {
  if (exit.clearanceOverride?.at) return true;
  const sections = exit.clearanceSections || [];
  if (sections.length) return sections.every((s) => s.completed);
  const c = exit.clearance || {};
  return ['itAssetsReturned', 'accessRevoked', 'knowledgeTransferDone', 'finalSettlementDone', 'documentsHandedOver']
    .every((k) => !!c[k]);
}

// Titles of the sections still pending — for a friendly gate message.
function pendingSectionTitles(exit) {
  return (exit.clearanceSections || []).filter((s) => !s.completed).map((s) => s.title);
}

// Ping a manager that a no-dues section has been assigned to them.
async function notifyClearanceAssignee(userId, exit, sectionTitle, applicantName) {
  try {
    await notify({
      recipient: userId,
      type: 'exit',
      audience: 'all',
      title: 'No-dues clearance assigned to you',
      body: `Please complete the ${sectionTitle} no-dues check for ${applicantName} (last working day ${fmtD(exit.lastWorkingDay)}).`,
      link: '/employee/approvals',
    });
  } catch (err) {
    console.error('clearance assignee notify failed:', err.message);
  }
}

// Ping every already-assigned section manager that clearance has begun. Called
// when an exit transitions into InClearance (approval finalised / termination).
async function notifyAssignedSections(exit, applicantName) {
  for (const s of exit.clearanceSections || []) {
    if (s.assignedTo && !s.completed) {
      await notifyClearanceAssignee(s.assignedTo, exit, s.title, applicantName);
    }
  }
}

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

// ============ Admin ============

/**
 * List exit requests with optional status/employee filters.
 * @route GET /api/exits  (HR/Admin)
 * @param {string} [req.query.status]
 * @param {string} [req.query.employee]
 * @returns {{count: number, exits: Object[]}} with populated employee/handledBy/initiatedBy
 */
// GET /api/exits  (HR/Admin)
const listExits = asyncHandler(async (req, res) => {
  const { status, employee } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (employee) filter.employee = employee;

  const exits = await ExitRequest.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user designation department',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('handledBy', 'firstName lastName email')
    .populate('initiatedBy', 'firstName lastName')
    .sort({ createdAt: -1 });
  res.json({ count: exits.length, exits });
});

/**
 * HR initiates an exit for an employee; a Resignation starts the approval ladder,
 * while Termination/Retirement go straight to clearance.
 * @route POST /api/exits  (HR/Admin)
 * @param {string} req.body.employee - EmployeeProfile id (required)
 * @param {string} req.body.lastWorkingDay - required
 * @param {string} [req.body.type='Resignation']
 * @param {string} [req.body.reason]
 * @param {string} [req.body.handledBy] - HR owner (defaults to hrPartner/caller)
 * @returns {{exit: Object}} (201); noticePeriodDays derived from the dates
 */
// POST /api/exits  (HR/Admin)  — initiate exit on behalf of an employee
const createExit = asyncHandler(async (req, res) => {
  const { employee, type, lastWorkingDay, reason, handledBy } = req.body;

  if (!employee || !lastWorkingDay) {
    res.status(400);
    throw new Error('employee and lastWorkingDay are required');
  }
  const profile = await EmployeeProfile.findById(employee).populate('user', 'firstName lastName');
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }

  // Default handler: explicit value > employee's permanent HR partner > current user
  const handler = handledBy || profile.hrPartner || req.user._id;
  const resignationDate = new Date();
  const exitType = type || 'Resignation';
  // A Resignation climbs the reporting-hierarchy approval chain before it enters
  // the notice period. Termination/Retirement are administrative HR actions with
  // no employee approval — they go straight to clearance.
  const status = exitType === 'Resignation' ? 'Pending' : 'InClearance';
  const exit = await ExitRequest.create({
    employee,
    type: exitType,
    lastWorkingDay,
    // Notice period is always derived from the dates so the two stay consistent.
    noticePeriodDays: deriveNoticeDays(resignationDate, lastWorkingDay),
    reason,
    handledBy: handler,
    initiatedBy: req.user._id,
    status,
    resignationDate,
    // Seed the per-department no-dues checklist (HR assigns managers later).
    clearanceSections: buildDefaultSections(),
  });

  if (exitType === 'Resignation') {
    await initResignationApproval(exit, profile, await applicantNameOf(profile));
  }

  res.status(201).json({ exit });
});

/**
 * Get a single exit request with related profile/user/handler populated.
 * @route GET /api/exits/:id  (HR/Admin)
 * @param {string} req.params.id - exit request id
 * @returns {{exit: Object}}
 */
// GET /api/exits/:id  (HR/Admin)
const getExit = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id)
    .populate({
      path: 'employee',
      populate: { path: 'user', select: 'firstName lastName email isActive' },
    })
    .populate('handledBy', 'firstName lastName email')
    .populate('initiatedBy', 'firstName lastName');
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  res.json({ exit });
});

/**
 * Edit an open exit's dates/reason/handler/clearance/status (not Completed/Cancelled).
 * @route PUT /api/exits/:id  (HR/Admin)
 * @param {string} req.params.id - exit request id
 * @param {Object} req.body - editable subset: type, lastWorkingDay, reason, handledBy, clearance, status
 * @returns {{exit: Object}}; noticePeriodDays re-derived from the dates
 */
// PUT /api/exits/:id  (HR/Admin)  — edit clearance, dates, reason, handler
const updateExit = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id);
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  if (exit.status === 'Completed' || exit.status === 'Cancelled') {
    res.status(400);
    throw new Error(`Cannot edit a ${exit.status} exit request`);
  }
  const editable = ['type', 'lastWorkingDay', 'reason', 'handledBy', 'clearance', 'status'];
  for (const k of editable) {
    if (req.body[k] !== undefined) exit[k] = req.body[k];
  }
  // noticePeriodDays is derived from the dates (date is the source of truth), so
  // it can never drift out of sync with the last working day.
  exit.noticePeriodDays = deriveNoticeDays(exit.resignationDate, exit.lastWorkingDay);
  // Disallow direct flip to terminal statuses from here
  if (exit.status === 'Completed' || exit.status === 'Cancelled') {
    res.status(400);
    throw new Error('Use the dedicated complete/cancel endpoints to close an exit');
  }
  await exit.save();
  res.json({ exit });
});

/**
 * Cancel an exit request (not allowed once Completed).
 * @route PATCH /api/exits/:id/cancel  (HR/Admin)
 * @param {string} req.params.id - exit request id
 * @param {string} [req.body.reason]
 * @returns {{exit: Object}} with status Cancelled
 */
// PATCH /api/exits/:id/cancel
const cancelExit = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id);
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  if (exit.status === 'Completed') {
    res.status(400);
    throw new Error('Cannot cancel a Completed exit');
  }
  exit.status = 'Cancelled';
  exit.cancelledAt = new Date();
  exit.cancellationReason = req.body.reason;
  await exit.save();
  res.json({ exit });
});

/**
 * Finalise an exit: stamp dateOfExit, deactivate the login, mint a feedback token,
 * and return a draft feedback email for HR to review (nothing is sent silently).
 * @route PATCH /api/exits/:id/complete  (HR/Admin)
 * @param {string} req.params.id - exit request id
 * @returns {{exit, email, feedbackUrl, mail?}} mail carries the draft to/subject/body
 * @sideeffect deactivates the employee's user account
 */
// PATCH /api/exits/:id/complete  — finalise: deactivate user, queue feedback email
const completeExit = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id)
    .populate({
      path: 'employee',
      populate: { path: 'user' },
    })
    .populate('handledBy');
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  if (exit.status === 'Completed') {
    res.status(400);
    throw new Error('Exit is already Completed');
  }
  if (exit.status === 'Cancelled') {
    res.status(400);
    throw new Error('Cannot complete a Cancelled exit');
  }

  // Last-working-day gate: a resigning employee keeps their access through their
  // last working day — the account must NOT be released before then. Normally the
  // notice-period worker releases it automatically the day after the LWD; HR can
  // release early (e.g. termination for cause / garden leave) only by explicitly
  // passing `force`/`releaseImmediately`.
  const force = req.body?.force === true || req.body?.releaseImmediately === true;
  const todayIST = startOfDayIST(new Date());
  const lwdIST = exit.lastWorkingDay ? startOfDayIST(exit.lastWorkingDay) : null;
  if (!force && lwdIST && todayIST < lwdIST) {
    res.status(400);
    throw new Error(
      `This employee's last working day is ${fmtD(exit.lastWorkingDay)}. Their access stays active until then and is ` +
      'released automatically after it. To revoke access immediately anyway (e.g. termination), confirm early release.'
    );
  }

  // No-dues gate: every department clearance section must be completed before
  // the account is released. HR can record an override (see overrideClearance).
  if (!clearanceSatisfied(exit)) {
    const pending = pendingSectionTitles(exit);
    res.status(400);
    throw new Error(
      `No-dues clearance is incomplete${pending.length ? ` — pending: ${pending.join(', ')}` : ''}. ` +
      'Have each department manager tick their section, or record an HR override.'
    );
  }

  // 1-3) Stamp dateOfExit, deactivate the login, ensure a feedback token, and
  // move the exit to Completed. Shared with the notice-period worker.
  await finalizeExit(exit);
  const profile = exit.employee;

  // 4) Hand the feedback email to the caller for review — HR sees and can edit
  //    the subject/body in the compose modal, then sends it through
  //    POST /exits/:id/resend-email. Nothing is emailed silently.
  const feedbackUrl = `${APP_BASE_URL()}/exit-feedback/${exit.feedbackToken}`;
  const empEmail = profile.user?.email;
  if (!empEmail) {
    exit.exitEmailLastError = 'Employee has no email on file';
    await exit.save();
    return res.json({
      exit,
      email: { queued: false, reason: exit.exitEmailLastError },
      feedbackUrl,
    });
  }

  const msg = buildExitEmail({
    employee: profile,
    hr: exit.handledBy,
    lastWorkingDay: exit.lastWorkingDay,
    feedbackUrl,
  });
  res.json({
    exit,
    email: { queued: false, pending: true },
    feedbackUrl,
    mail: { to: empEmail, subject: msg.subject, body: msg.text },
  });
});

/**
 * Preview or send the exit-feedback email (exit must be Completed).
 * @route POST /api/exits/:id/resend-email  (HR/Admin)
 * @param {string} req.params.id - exit request id
 * @param {boolean} [req.body.preview] - true returns the default draft without sending
 * @param {string} [req.body.subject] - HR override
 * @param {string} [req.body.body] - HR override (branded HTML dropped when edited)
 * @returns {{exit, email, feedbackUrl}} or the draft {to, subject, body, feedbackUrl} in preview mode
 * @sideeffect enqueues an outbound email unless preview
 */
// POST /api/exits/:id/resend-email  { subject?, body?, preview? }
// Preview or enqueue the exit feedback email. With preview: true it returns
// the default recipient/subject/body for the compose modal; otherwise it
// queues the mail, honouring any HR-edited subject/body.
const resendExitEmail = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id)
    .populate({ path: 'employee', populate: { path: 'user' } })
    .populate('handledBy');
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  if (exit.status !== 'Completed') {
    res.status(400);
    throw new Error('Exit must be Completed before the email can be sent');
  }
  if (!exit.feedbackToken) {
    exit.feedbackToken = generateToken();
    exit.feedbackTokenExpiresAt = new Date(Date.now() + FEEDBACK_TTL_DAYS * 86400 * 1000);
    await exit.save();
  }
  const feedbackUrl = `${APP_BASE_URL()}/exit-feedback/${exit.feedbackToken}`;
  const empEmail = exit.employee.user?.email;
  if (!empEmail) {
    res.status(400);
    throw new Error('Employee has no email on file');
  }
  const msg = buildExitEmail({
    employee: exit.employee,
    hr: exit.handledBy,
    lastWorkingDay: exit.lastWorkingDay,
    feedbackUrl,
  });
  if (req.body?.preview) {
    return res.json({ to: empEmail, subject: msg.subject, body: msg.text, feedbackUrl });
  }

  const subject = String(req.body?.subject || '').trim() || msg.subject;
  const customBody = String(req.body?.body || '').trim();
  const outboxRow = await enqueueMail(
    {
      to: empEmail,
      subject,
      text: customBody || msg.text,
      // The branded HTML alternative is only safe when the body is unedited —
      // what HR approved must be exactly what's delivered.
      html: customBody ? undefined : msg.html,
      replyTo: exit.handledBy?.email,
    },
    { type: 'exit', id: exit._id }
  );
  exit.exitEmailQueuedAt = new Date();
  exit.exitEmailLastError = undefined;
  await exit.save();
  res.json({ exit, email: { queued: true, outboxId: outboxRow._id }, feedbackUrl });
});

// ============ No-dues clearance ============

/**
 * Assign the responsible manager for each no-dues section (HR/Admin).
 * @route PATCH /api/exits/:id/clearance-assignees  (HR/Admin)
 * @param {Object} req.body.assignees - map of section key -> User id (or null to unassign)
 * @returns {{exit: Object}}; notifies newly-assigned managers to complete their section
 */
const assignClearanceApprovers = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id);
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  if (exit.status === 'Completed' || exit.status === 'Cancelled') {
    res.status(400);
    throw new Error(`Cannot edit clearance on a ${exit.status} exit`);
  }
  if (!exit.clearanceSections?.length) exit.clearanceSections = buildDefaultSections();

  const assignees = req.body?.assignees || {};
  const applicantName = await applicantNameOf(exit.employee);
  const newlyAssigned = [];
  for (const section of exit.clearanceSections) {
    if (!(section.key in assignees)) continue;
    const userId = assignees[section.key] || null;
    const prev = String(section.assignedTo || '');
    if (String(userId || '') === prev) continue;
    section.assignedTo = userId || null;
    if (userId) {
      const u = await User.findById(userId).select('firstName lastName');
      section.assignedToName = u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '';
      newlyAssigned.push({ userId, title: section.title });
    } else {
      section.assignedToName = '';
    }
  }
  await exit.save();

  // Only ping assignees once the exit is actually in clearance (notice period).
  if (exit.status === 'InClearance') {
    for (const a of newlyAssigned) await notifyClearanceAssignee(a.userId, exit, a.title, applicantName);
  }
  res.json({ exit });
});

/**
 * Core: apply an items update to one clearance section and recompute completion.
 * `privileged` (HR/SuperAdmin) may edit any section; otherwise the actor must be
 * the section's assignee. Editable only while the exit is InClearance.
 * Mutates + saves; throws Error with `.status` on a bad request.
 */
async function recordClearanceSection(exit, key, userId, privileged, payload) {
  if (exit.status !== 'InClearance') {
    const e = new Error('No-dues can only be updated while the exit is serving notice (in clearance).');
    e.status = 400;
    throw e;
  }
  const section = (exit.clearanceSections || []).find((s) => s.key === key);
  if (!section) {
    const e = new Error('Clearance section not found.');
    e.status = 404;
    throw e;
  }
  if (!privileged && String(section.assignedTo || '') !== String(userId)) {
    const e = new Error('This no-dues section is not assigned to you.');
    e.status = 403;
    throw e;
  }
  const incoming = Array.isArray(payload?.items) ? payload.items : [];
  section.items.forEach((it, i) => {
    const upd = incoming[i];
    if (!upd) return;
    const nextDone = !!upd.done;
    if (nextDone !== it.done) {
      it.done = nextDone;
      it.doneAt = nextDone ? new Date() : undefined;
      it.doneBy = nextDone ? userId : undefined;
    }
    if (upd.note !== undefined) it.note = upd.note;
  });
  recomputeSection(section, userId);
  await exit.save();
  return section;
}

/**
 * HR/Admin ticks a no-dues section from the Exit console.
 * @route PATCH /api/exits/:id/clearance/:key  (HR/Admin)
 * @param {Object} req.body.items - array of { done, note } by item index
 * @returns {{exit: Object}}
 */
const updateClearanceSectionAdmin = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id);
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  try {
    await recordClearanceSection(exit, req.params.key, req.user._id, true, req.body);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ exit });
});

/**
 * HR/Admin overrides the no-dues gate so the account can be released with pending
 * sections, on record with a reason.
 * @route PATCH /api/exits/:id/clearance/override  (HR/Admin)
 * @param {string} req.body.reason - required justification
 * @returns {{exit: Object}}
 */
const overrideClearance = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findById(req.params.id);
  if (!exit) {
    res.status(404);
    throw new Error('Exit request not found');
  }
  const reason = String(req.body?.reason || '').trim();
  if (!reason) {
    res.status(400);
    throw new Error('A reason is required to override the no-dues clearance.');
  }
  exit.clearanceOverride = {
    by: req.user._id,
    byName: req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    at: new Date(),
    reason,
  };
  await exit.save();
  res.json({ exit });
});

// ============ Employee self-service ============

/**
 * Get the calling employee's most recent exit request.
 * @route GET /api/exits/me
 * @returns {{exit: Object|null}} with populated handledBy
 */
// GET /api/exits/me  — the calling employee's open or completed exit
const getMyExit = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const exit = await ExitRequest.findOne({ employee: profile._id })
    .sort({ createdAt: -1 })
    .populate('handledBy', 'firstName lastName email');
  res.json({ exit });
});

/**
 * Employee submits their own resignation, kicking off the approval ladder.
 * @route POST /api/exits/me
 * @param {string} req.body.lastWorkingDay - required
 * @param {string} [req.body.reason]
 * @returns {{exit: Object}} (201); 409 if an open exit already exists
 */
// POST /api/exits/me  — submit your own resignation
const submitMyResignation = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const { lastWorkingDay, reason } = req.body;
  if (!lastWorkingDay) {
    res.status(400);
    throw new Error('lastWorkingDay is required');
  }
  const existing = await ExitRequest.findOne({
    employee: profile._id,
    status: { $in: ['Pending', 'InClearance'] },
  });
  if (existing) {
    res.status(409);
    throw new Error('You already have an open exit request');
  }
  const resignationDate = new Date();
  const exit = await ExitRequest.create({
    employee: profile._id,
    type: 'Resignation',
    lastWorkingDay,
    reason,
    // Notice period derived from the dates → always consistent.
    noticePeriodDays: deriveNoticeDays(resignationDate, lastWorkingDay),
    resignationDate,
    // Route HR notifications to the employee's permanent HR partner if set.
    handledBy: profile.hrPartner || undefined,
    initiatedBy: req.user._id,
    status: 'Pending',
    // Seed the per-department no-dues checklist (HR assigns managers later).
    clearanceSections: buildDefaultSections(),
  });
  // Kick off the reporting-hierarchy approval ladder.
  const applicantName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'An employee';
  await initResignationApproval(exit, profile, applicantName);
  res.status(201).json({ exit });
});

// ============ Public feedback ============

/**
 * Public: fetch the context for the exit-feedback form via its token.
 * @route GET /api/exits/feedback/:token  (PUBLIC, no auth)
 * @param {string} req.params.token - feedbackToken
 * @returns {Object} employeeName, handledBy, lastWorkingDay, orgName, alreadySubmitted; 410 if expired
 */
// GET /api/exits/feedback/:token   — public
const getFeedbackContext = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findOne({ feedbackToken: req.params.token })
    .populate({ path: 'employee', populate: { path: 'user', select: 'firstName lastName' } })
    .populate('handledBy', 'firstName lastName');
  if (!exit) {
    res.status(404);
    throw new Error('This feedback link is invalid or has been revoked');
  }
  if (exit.feedbackTokenExpiresAt && exit.feedbackTokenExpiresAt < new Date()) {
    res.status(410);
    throw new Error('This feedback link has expired');
  }
  res.json({
    employeeName: `${exit.employee.user?.firstName || ''} ${exit.employee.user?.lastName || ''}`.trim(),
    handledBy: exit.handledBy
      ? `${exit.handledBy.firstName} ${exit.handledBy.lastName}`
      : null,
    lastWorkingDay: exit.lastWorkingDay,
    orgName: process.env.ORG_DISPLAY_NAME || 'Sequence Surface',
    alreadySubmitted: !!exit.feedback?.submittedAt,
    submittedAt: exit.feedback?.submittedAt,
  });
});

/**
 * Public: submit exit-feedback answers via the token (one submission only).
 * @route POST /api/exits/feedback/:token  (PUBLIC, no auth)
 * @param {string} req.params.token - feedbackToken
 * @param {Object} req.body - primaryReason, likedMost, couldImprove, recommendScore, openFeedback
 * @returns {{ok: true, submittedAt}}; 409 if already submitted, 410 if expired
 */
// POST /api/exits/feedback/:token   — public
const submitFeedback = asyncHandler(async (req, res) => {
  const exit = await ExitRequest.findOne({ feedbackToken: req.params.token });
  if (!exit) {
    res.status(404);
    throw new Error('This feedback link is invalid');
  }
  if (exit.feedbackTokenExpiresAt && exit.feedbackTokenExpiresAt < new Date()) {
    res.status(410);
    throw new Error('This feedback link has expired');
  }
  if (exit.feedback?.submittedAt) {
    res.status(409);
    throw new Error('Feedback has already been submitted for this exit');
  }
  const { primaryReason, likedMost, couldImprove, recommendScore, openFeedback } = req.body;
  exit.feedback = {
    primaryReason,
    likedMost,
    couldImprove,
    recommendScore: Number(recommendScore) || undefined,
    openFeedback,
    submittedAt: new Date(),
    submittedFromIp: req.ip,
  };
  await exit.save();
  res.json({ ok: true, submittedAt: exit.feedback.submittedAt });
});

module.exports = {
  listExits,
  createExit,
  getExit,
  updateExit,
  cancelExit,
  completeExit,
  resendExitEmail,
  getMyExit,
  submitMyResignation,
  getFeedbackContext,
  submitFeedback,
  // No-dues clearance
  assignClearanceApprovers,
  updateClearanceSectionAdmin,
  overrideClearance,
  // Shared with the approvals controller and the exit worker
  advanceExitApproval,
  ensureExitApprovalChain,
  finalizeExit,
  recordClearanceSection,
  clearanceSatisfied,
};
