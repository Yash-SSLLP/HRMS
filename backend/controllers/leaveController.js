const asyncHandler = require('express-async-handler');
const { LeaveRequest, LeaveBalance, LEAVE_TYPES } = require('../models/Leave');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { enqueueMail } = require('../services/email');
const { notify, notifyMany } = require('../services/notify');
const { daysInclusive, currentYear } = require('../utils/dateHelpers');

// Leave types that draw down from a tracked balance bucket
const BALANCED_TYPES = ['EL', 'CL', 'SL', 'ML'];

// Build the reporting-hierarchy approval ladder for an applicant. Walk up the
// `reportingManager` links (each is a User → find THAT user's EmployeeProfile to
// get the next manager) and add one rung per active manager, stopping once we
// include the first CEO/MD (the top of the ladder). Inactive managers are
// skipped over (we keep climbing to their manager). Guards against cycles.
async function buildApprovalChain(profile) {
  const chain = [];
  const seen = new Set([String(profile.user)]); // never loop back to the applicant
  let managerId = profile.reportingManager;
  let depth = 0;
  while (managerId && depth < 20) {
    depth += 1;
    const mid = String(managerId);
    if (seen.has(mid)) break; // cycle guard
    seen.add(mid);
    const mgr = await User.findById(managerId).select('firstName lastName role isActive');
    if (!mgr) break;
    const mgrProfile = await EmployeeProfile.findOne({ user: mgr._id }).select('reportingManager');
    const nextManagerId = mgrProfile?.reportingManager || null;
    if (mgr.isActive !== false) {
      chain.push({
        approver: mgr._id,
        approverName: `${mgr.firstName || ''} ${mgr.lastName || ''}`.trim(),
        role: mgr.role,
        order: chain.length,
        status: 'Waiting',
      });
      // The CEO/MD is the final approver — don't climb past them.
      if (mgr.role === 'CEO' || mgr.role === 'MD') break;
    }
    managerId = nextManagerId;
  }
  return chain;
}

async function applicantNameOf(request) {
  const prof = await EmployeeProfile.findById(request.employee)
    .select('user')
    .populate('user', 'firstName lastName');
  return `${prof?.user?.firstName || ''} ${prof?.user?.lastName || ''}`.trim() || 'An employee';
}

// In-app + email nudge to the person whose turn it is to approve. Best-effort.
async function notifyApprover(approverUserId, request, applicantName) {
  try {
    await notify({
      recipient: approverUserId,
      type: 'leave',
      title: 'Leave needs your approval',
      body: `${applicantName} applied for ${request.leaveType} leave (${request.totalDays}d) — it's awaiting your approval.`,
      link: 'leave',
    });
    const appr = await User.findById(approverUserId).select('email');
    if (appr?.email) {
      await enqueueMail(
        {
          to: [appr.email],
          subject: `Leave approval needed — ${applicantName} (${request.leaveType}, ${request.totalDays}d)`,
          text: [
            `${applicantName} has a ${request.leaveType} leave request (${request.totalDays} day(s)) awaiting your approval.`,
            '',
            'Review and approve/reject it in the HRMS portal under Leave Approvals.',
          ].join('\n'),
        },
        { type: 'leave', id: request._id }
      );
    }
  } catch (err) {
    console.error('approver notify failed:', err.message);
  }
}

// Tell the applicant their leave was approved/rejected. Best-effort.
async function notifyEmployeeDecision(request, note) {
  try {
    const prof = await EmployeeProfile.findById(request.employee).select('user');
    if (!prof?.user) return;
    const approved = request.status === 'Approved';
    const days = `${request.totalDays} day${request.totalDays === 1 ? '' : 's'}`;
    await notify({
      recipient: prof.user,
      type: 'leave',
      title: approved ? 'Leave approved' : 'Leave rejected',
      body: `Your ${request.leaveType} leave (${days}) has been ${approved ? 'approved' : 'rejected'}.${note ? ` Note: ${note}` : ''}`,
      link: 'leave',
    });
  } catch (err) {
    console.error('leave decision notify failed:', err.message);
  }
}

// HR is informed (not an approval rung): notify the employee's HR partner + a
// SuperAdmin once a request is fully approved or rejected through the hierarchy.
async function notifyHrInformational(request, verb) {
  try {
    const prof = await EmployeeProfile.findById(request.employee)
      .select('user hrPartner')
      .populate('user', 'firstName lastName');
    const ids = new Set();
    if (prof?.hrPartner) ids.add(String(prof.hrPartner));
    const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
    if (sa) ids.add(String(sa._id));
    if (!ids.size) return;
    const name = `${prof?.user?.firstName || ''} ${prof?.user?.lastName || ''}`.trim() || 'An employee';
    await notifyMany([...ids], {
      type: 'leave',
      title: `Leave ${verb}`,
      body: `${name}'s ${request.leaveType} leave (${request.totalDays}d) was ${verb} via the reporting hierarchy.`,
      link: 'leave',
    });
  } catch (err) {
    console.error('HR informational notify failed:', err.message);
  }
}

// After a rejection, tell the approvers ABOVE the rejecter (who never got their
// turn) so e.g. a CEO sees that a lower manager rejected the request.
async function notifyChainAbove(request, rejectedStep) {
  try {
    if (!rejectedStep) return;
    const above = (request.approvalChain || []).filter((s) => s.order > rejectedStep.order && s.approver);
    const ids = above.map((s) => s.approver);
    if (!ids.length) return;
    const name = await applicantNameOf(request);
    await notifyMany(ids, {
      type: 'leave',
      title: 'Leave rejected below you',
      body: `${name}'s ${request.leaveType} leave was rejected by ${rejectedStep.approverName || 'a manager'} before it reached you.`,
      link: 'leave',
    });
  } catch (err) {
    console.error('chain-above notify failed:', err.message);
  }
}

// Email the employee's HR partner (falling back to a SuperAdmin) about a new
// leave request. Reply-To is the applicant's address so the HR can reply to the
// employee directly. Best-effort — never blocks the leave application.
async function emailLeaveToHr(profile, request, applicant) {
  try {
    // Notify the reporting manager (who can now approve) and the HR partner,
    // falling back to a SuperAdmin if neither is set.
    const recipients = new Set();
    if (profile.reportingManager) {
      const mgr = await User.findById(profile.reportingManager).select('email');
      if (mgr?.email) recipients.add(mgr.email);
    }
    if (profile.hrPartner) {
      const hr = await User.findById(profile.hrPartner).select('email');
      if (hr?.email) recipients.add(hr.email);
    }
    if (recipients.size === 0) {
      const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('email');
      if (sa?.email) recipients.add(sa.email);
    }
    if (recipients.size === 0) return;

    const name = `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim() || 'An employee';
    const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const range = request.isHalfDay
      ? `${fmt(request.startDate)} (${request.halfDaySession === 'FirstHalf' ? '1st half' : '2nd half'})`
      : `${fmt(request.startDate)} – ${fmt(request.endDate)}`;

    await enqueueMail(
      {
        to: [...recipients],
        replyTo: applicant.email,
        subject: `Leave request from ${name} (${request.leaveType}, ${request.totalDays}d)`,
        text: [
          `${name} has applied for leave and needs your approval.`,
          '',
          `Type       : ${request.leaveType}`,
          `Dates      : ${range}`,
          `Total days : ${request.totalDays}`,
          `Reason     : ${request.reason || '—'}`,
          '',
          'Review and approve/reject it in the HRMS portal under Leave.',
          `Reply to this email to reach ${name} directly.`,
        ].join('\n'),
      },
      { type: 'leave', id: request._id }
    );
  } catch (err) {
    console.error('Leave HR email failed:', err.message);
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

async function getOrCreateBalance(employeeId, year) {
  let balance = await LeaveBalance.findOne({ employee: employeeId, year });
  if (!balance) {
    balance = await LeaveBalance.create({ employee: employeeId, year });
  }
  return balance;
}

function adjustBalance(balance, leaveType, delta) {
  // delta > 0 → consume; delta < 0 → restore
  if (!BALANCED_TYPES.includes(leaveType)) return;
  const bucket = balance.balances[leaveType];
  if (!bucket) return;
  bucket.used = (bucket.used || 0) + delta;
  bucket.balance = (bucket.balance || 0) - delta;
}

// ===== Employee self-service =====

// GET /api/leave/me/balance?year=
const getMyBalance = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const year = Number(req.query.year) || currentYear();
  const balance = await getOrCreateBalance(profile._id, year);
  res.json({ balance });
});

// GET /api/leave/me/requests
const listMyRequests = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const requests = await LeaveRequest.find({ employee: profile._id })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

// POST /api/leave/me/requests
const applyForLeave = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const { leaveType, startDate, endDate, isHalfDay, halfDaySession, reason } = req.body;

  if (!leaveType || !startDate || !endDate) {
    res.status(400);
    throw new Error('leaveType, startDate, endDate are required');
  }
  if (!LEAVE_TYPES.includes(leaveType)) {
    res.status(400);
    throw new Error(`Invalid leaveType. Allowed: ${LEAVE_TYPES.join(', ')}`);
  }

  let totalDays;
  if (isHalfDay) {
    if (new Date(startDate).toDateString() !== new Date(endDate).toDateString()) {
      res.status(400);
      throw new Error('Half-day leave must have the same startDate and endDate');
    }
    if (!halfDaySession) {
      res.status(400);
      throw new Error('halfDaySession (FirstHalf|SecondHalf) is required for half-day leave');
    }
    totalDays = 0.5;
  } else {
    totalDays = daysInclusive(startDate, endDate);
    if (totalDays <= 0) {
      res.status(400);
      throw new Error('endDate must be on/after startDate');
    }
  }

  // Build the reporting-hierarchy approval ladder. The first rung is Pending
  // (their turn); the rest wait. Empty chain = no reporting manager → HR decides.
  const chain = await buildApprovalChain(profile);
  if (chain.length) chain[0].status = 'Pending';

  const request = await LeaveRequest.create({
    employee: profile._id,
    leaveType,
    startDate,
    endDate,
    isHalfDay: !!isHalfDay,
    halfDaySession,
    totalDays,
    reason,
    approvalChain: chain,
    currentApprover: chain.length ? chain[0].approver : null,
  });

  const applicantName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'An employee';
  if (chain.length) {
    // Ping only the first approver; the chain climbs from there.
    await notifyApprover(chain[0].approver, request, applicantName);
  } else {
    // No manager in the hierarchy — fall back to HR/SuperAdmin to force-decide.
    await emailLeaveToHr(profile, request, req.user);
    try {
      const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
      if (sa) {
        await notify({
          recipient: sa._id,
          type: 'leave',
          title: 'Leave needs a decision',
          body: `${applicantName} applied for ${request.leaveType} leave (${request.totalDays}d) but has no reporting manager — please review.`,
          link: 'leave',
        });
      }
    } catch (err) {
      console.error('no-chain HR notify failed:', err.message);
    }
  }

  res.status(201).json({ request });
});

// PATCH /api/leave/me/requests/:id/cancel
const cancelMyRequest = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const request = await LeaveRequest.findOne({
    _id: req.params.id,
    employee: profile._id,
  });
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  if (request.status === 'Cancelled' || request.status === 'Rejected') {
    res.status(400);
    throw new Error(`Request is already ${request.status}`);
  }

  // If it was already approved, restore the balance (deducted only at final approval).
  if (request.status === 'Approved') {
    const year = new Date(request.startDate).getFullYear();
    const balance = await getOrCreateBalance(profile._id, year);
    adjustBalance(balance, request.leaveType, -request.totalDays);
    await balance.save();
  }

  // Stop the approval ladder: no one's turn any more, pending/waiting rungs void.
  request.currentApprover = null;
  for (const s of request.approvalChain || []) {
    if (s.status === 'Pending' || s.status === 'Waiting') s.status = 'Skipped';
  }
  request.status = 'Cancelled';
  request.decisionAt = new Date();
  await request.save();
  res.json({ request });
});

// ===== HR/Admin endpoints =====

// GET /api/leave/requests?employee=&status=&from=&to=
const listAllRequests = asyncHandler(async (req, res) => {
  const { employee, status, from, to } = req.query;
  const filter = {};
  if (employee) filter.employee = employee;
  if (status) filter.status = status;
  if (from || to) {
    filter.startDate = {};
    if (from) filter.startDate.$gte = new Date(from);
    if (to) filter.startDate.$lte = new Date(to);
  }
  const requests = await LeaveRequest.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

// Deduct the balance bucket for an approval, throwing a 400 if insufficient.
// No-op for unbalanced leave types (PL/COMP/LOP).
async function consumeBalanceOrThrow(request) {
  if (!BALANCED_TYPES.includes(request.leaveType)) return;
  const year = new Date(request.startDate).getFullYear();
  const balance = await getOrCreateBalance(request.employee, year);
  const available = balance.balances[request.leaveType]?.balance || 0;
  if (available < request.totalDays) {
    const err = new Error(`Insufficient ${request.leaveType} balance (have ${available}, need ${request.totalDays})`);
    err.status = 400;
    throw err;
  }
  adjustBalance(balance, request.leaveType, request.totalDays);
  await balance.save();
}

// Hierarchy step decision — the normal path. The acting user MUST be the current
// approver. Approve → advance to the next rung, or (if last) finalize + deduct
// balance. Reject → stop the chain, rejection stays visible to rungs above.
// Mutates + saves the request; throws Error with `.status` on a bad transition.
async function advanceApproval(request, userId, action, note) {
  if (request.status !== 'Pending') {
    const err = new Error(`Cannot ${action} — this request is ${request.status}.`);
    err.status = 400;
    throw err;
  }
  if (!request.currentApprover || String(request.currentApprover) !== String(userId)) {
    const err = new Error('This leave request is not awaiting your approval.');
    err.status = 403;
    throw err;
  }
  const now = new Date();
  const step = (request.approvalChain || []).find(
    (s) => String(s.approver) === String(userId) && s.status === 'Pending'
  );

  if (action === 'reject') {
    if (step) { step.status = 'Rejected'; step.decidedAt = now; step.note = note; }
    for (const s of request.approvalChain || []) {
      if (s.status === 'Waiting') s.status = 'Skipped';
    }
    request.status = 'Rejected';
    request.currentApprover = null;
    request.approver = userId;
    request.decisionAt = now;
    request.decisionNote = note;
    await request.save();
    await notifyEmployeeDecision(request, note);
    await notifyChainAbove(request, step);
    await notifyHrInformational(request, 'rejected');
    return request;
  }

  // Approve — is there a rung above me still waiting?
  const next = (request.approvalChain || []).find(
    (s) => s.status === 'Waiting' && (!step || s.order > step.order)
  );
  if (next) {
    if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
    next.status = 'Pending';
    request.currentApprover = next.approver;
    await request.save();
    await notifyApprover(next.approver, request, await applicantNameOf(request));
    return request;
  }

  // I'm the top rung — finalize. Deduct balance FIRST (may throw before we save).
  await consumeBalanceOrThrow(request);
  if (step) { step.status = 'Approved'; step.decidedAt = now; step.note = note; }
  request.status = 'Approved';
  request.currentApprover = null;
  request.approver = userId;
  request.decisionAt = now;
  request.decisionNote = note;
  await request.save();
  await notifyEmployeeDecision(request, note);
  await notifyHrInformational(request, 'fully approved');
  return request;
}

// HR/SuperAdmin emergency OVERRIDE — force a final decision regardless of where
// the request sits in the chain (safety valve for stuck requests). Records an
// override rung and voids any pending/waiting rungs. Mutates + saves; throws
// Error with `.status` on a bad transition or insufficient balance.
async function applyLeaveDecision(request, userId, action, note) {
  if (request.status !== 'Pending') {
    const err = new Error(`Cannot ${action} from status ${request.status}`);
    err.status = 400;
    throw err;
  }
  if (action === 'approve') {
    await consumeBalanceOrThrow(request);
    request.status = 'Approved';
  } else {
    request.status = 'Rejected';
  }
  for (const s of request.approvalChain || []) {
    if (s.status === 'Pending' || s.status === 'Waiting') s.status = 'Skipped';
  }
  (request.approvalChain = request.approvalChain || []).push({
    approver: userId,
    approverName: 'HR override',
    role: 'Override',
    order: request.approvalChain.length,
    status: action === 'approve' ? 'Approved' : 'Rejected',
    decidedAt: new Date(),
    note,
  });
  request.currentApprover = null;
  request.approver = userId;
  request.decisionAt = new Date();
  request.decisionNote = note;
  await request.save();
  await notifyEmployeeDecision(request, note);
  if (action === 'approve') await notifyHrInformational(request, 'approved (HR override)');
  return request;
}

// PATCH /api/leave/requests/:id/approve
const approveRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await applyLeaveDecision(request, req.user._id, 'approve', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// PATCH /api/leave/requests/:id/reject
const rejectRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  try {
    await applyLeaveDecision(request, req.user._id, 'reject', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

// GET /api/leave/balances?year= — list balances (admin)
const listBalances = asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || currentYear();
  const balances = await LeaveBalance.find({ year }).populate({
    path: 'employee',
    select: 'employeeCode user',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  res.json({ year, count: balances.length, balances });
});

// PUT /api/leave/balances/:employeeId/:year — upsert grant for an employee/year
const upsertBalance = asyncHandler(async (req, res) => {
  const { employeeId, year } = req.params;
  const profile = await EmployeeProfile.findById(employeeId);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  const balance = await getOrCreateBalance(profile._id, Number(year));
  const { balances } = req.body || {};
  if (balances) {
    for (const type of Object.keys(balances)) {
      if (!balance.balances[type]) continue;
      Object.assign(balance.balances[type], balances[type]);
      // Recompute balance for that bucket: opening + granted - used
      const b = balance.balances[type];
      b.balance =
        (b.opening || 0) + (b.granted || 0) - (b.used || 0) - (b.encashed || 0);
    }
  }
  await balance.save();
  res.json({ balance });
});

module.exports = {
  getMyBalance,
  listMyRequests,
  applyForLeave,
  cancelMyRequest,
  listAllRequests,
  approveRequest,
  rejectRequest,
  listBalances,
  upsertBalance,
  applyLeaveDecision,
  advanceApproval,
  buildApprovalChain,
};
