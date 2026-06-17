const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const ExitRequest = require('../models/ExitRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { enqueueMail } = require('../services/email');
const { buildExitEmail } = require('../services/exitEmails');

const APP_BASE_URL = () => process.env.APP_BASE_URL || 'http://localhost:5173';
const FEEDBACK_TTL_DAYS = 60;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
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

// POST /api/exits  (HR/Admin)  — initiate exit on behalf of an employee
const createExit = asyncHandler(async (req, res) => {
  const { employee, type, lastWorkingDay, noticePeriodDays, reason, handledBy } = req.body;

  if (!employee || !lastWorkingDay) {
    res.status(400);
    throw new Error('employee and lastWorkingDay are required');
  }
  const profile = await EmployeeProfile.findById(employee);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }

  // Default handler: explicit value > employee's permanent HR partner > current user
  const handler = handledBy || profile.hrPartner || req.user._id;
  const exit = await ExitRequest.create({
    employee,
    type: type || 'Resignation',
    lastWorkingDay,
    noticePeriodDays,
    reason,
    handledBy: handler,
    initiatedBy: req.user._id,
    status: 'Pending',
    resignationDate: new Date(),
  });

  res.status(201).json({ exit });
});

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
  const editable = ['type', 'lastWorkingDay', 'noticePeriodDays', 'reason', 'handledBy', 'clearance', 'status'];
  for (const k of editable) {
    if (req.body[k] !== undefined) exit[k] = req.body[k];
  }
  // Disallow direct flip to terminal statuses from here
  if (exit.status === 'Completed' || exit.status === 'Cancelled') {
    res.status(400);
    throw new Error('Use the dedicated complete/cancel endpoints to close an exit');
  }
  await exit.save();
  res.json({ exit });
});

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

  // 1) Feedback token (long-lived; single-use until submitted)
  if (!exit.feedbackToken) {
    exit.feedbackToken = generateToken();
    exit.feedbackTokenExpiresAt = new Date(Date.now() + FEEDBACK_TTL_DAYS * 86400 * 1000);
  }

  // 2) Mark the employee profile as exited & deactivate the login
  const profile = exit.employee;
  profile.dateOfExit = exit.lastWorkingDay;
  await profile.save();
  if (profile.user) {
    profile.user.isActive = false;
    await profile.user.save();
  }

  // 3) Move the exit to Completed
  exit.status = 'Completed';
  exit.completedAt = new Date();
  await exit.save();

  // 4) Enqueue the email — worker delivers + retries with backoff
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
  const outboxRow = await enqueueMail(
    {
      to: empEmail,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      replyTo: exit.handledBy?.email,
    },
    { type: 'exit', id: exit._id }
  );

  exit.exitEmailQueuedAt = new Date();
  exit.exitEmailLastError = undefined;
  await exit.save();

  res.json({
    exit,
    email: { queued: true, outboxId: outboxRow._id },
    feedbackUrl,
  });
});

// POST /api/exits/:id/resend-email  — enqueue a fresh delivery attempt
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
  const outboxRow = await enqueueMail(
    {
      to: empEmail,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      replyTo: exit.handledBy?.email,
    },
    { type: 'exit', id: exit._id }
  );
  exit.exitEmailQueuedAt = new Date();
  exit.exitEmailLastError = undefined;
  await exit.save();
  res.json({ exit, email: { queued: true, outboxId: outboxRow._id }, feedbackUrl });
});

// ============ Employee self-service ============

// GET /api/exits/me  — the calling employee's open or completed exit
const getMyExit = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const exit = await ExitRequest.findOne({ employee: profile._id })
    .sort({ createdAt: -1 })
    .populate('handledBy', 'firstName lastName email');
  res.json({ exit });
});

// POST /api/exits/me  — submit your own resignation
const submitMyResignation = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const { lastWorkingDay, reason, noticePeriodDays } = req.body;
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
  const exit = await ExitRequest.create({
    employee: profile._id,
    type: 'Resignation',
    lastWorkingDay,
    reason,
    noticePeriodDays,
    resignationDate: new Date(),
    initiatedBy: req.user._id,
    status: 'Pending',
  });
  res.status(201).json({ exit });
});

// ============ Public feedback ============

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
};
