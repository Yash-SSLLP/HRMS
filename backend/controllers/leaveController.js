/**
 * Leave controller — leave requests (LeaveRequest) and per-year balances
 * (LeaveBalance). Employees apply/cancel and see their balance; requests climb a
 * reporting-hierarchy approval ladder (buildApprovalChain) with email/in-app
 * nudges. Final approval deducts the balance bucket and auto-stamps the covered
 * working days onto the attendance calendar; HR has an override path. Several
 * helpers are exported for the approvals/manager controllers.
 */
const asyncHandler = require('express-async-handler');
const {
  LeaveRequest, LeaveBalance, LEAVE_TYPES, EMERGENCY_LEAVE, UNPAID_LEAVE,
  isUnpaidType, isMaternityType, isEmergencyType,
} = require('../models/Leave');
const EmployeeProfile = require('../models/EmployeeProfile');
const { scopeEmployeeFilter, cannotManageProfile } = require('../utils/employeeScope');
const User = require('../models/User');
const Attendance = require('../models/Attendance');
const Holiday = require('../models/Holiday');
const { enqueueMail } = require('../services/email');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');
const { daysInclusive, currentYear, startOfDayIST, ymdIST, monthRangeIST } = require('../utils/dateHelpers');
const { daysOnPayroll, prorateAllowance } = require('../utils/monthlyQuota');
const { hasPermission } = require('../middleware/authMiddleware');

// Company leave policy: 2 PAID leave days per calendar month, settled monthly
// (no carry-forward). Any leave day beyond the 2/month quota is Loss of Pay
// (unpaid). Mirrors PAID_LEAVE_QUOTA in payrollController — keep them in sync.
// It is a full month's entitlement: a mid-month joiner/leaver gets a share of it,
// via the shared prorateAllowance the payroll run uses (utils/monthlyQuota).
const MONTHLY_PAID_LEAVE = 2;

// This employee's paid-leave quota for one IST month ('YYYY-MM'), prorated when
// they were only on the payroll for part of it.
function monthlyQuotaFor(profile, ym) {
  const [Y, M] = ym.split('-').map(Number);
  const { daysInMonth, eligibleDays } = daysOnPayroll(profile, Y, M);
  return prorateAllowance(MONTHLY_PAID_LEAVE, eligibleDays, daysInMonth);
}

// Only Maternity Leave draws down a banked entitlement (the ML bucket, 182 days).
// Paid / Unpaid / Emergency are governed by the monthly quota above, so they
// never draw a bucket and never block approval on a zero balance.
// Returns the LeaveBalance.balances key a type consumes, or null for none.
function balanceBucketFor(leaveType) {
  return isMaternityType(leaveType) ? 'ML' : null;
}

// Emergency leave: granted without approval, but from this many in a calendar
// month it is flagged to the reporting hierarchy and HR as a repeat.
const EMERGENCY_FLAG_FROM = 2;

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

// Build the ladder from the SuperAdmin-CONFIGURED list on the profile
// (`leaveApprovers`, 1–4 people, in order). Inactive users and the applicant
// themselves are dropped rather than failing the whole chain, so deactivating
// someone degrades the ladder instead of stranding every request behind them.
// Returns [] when nothing usable is configured.
async function buildConfiguredLeaveChain(profile) {
  const ids = (profile.leaveApprovers || []).map(String).filter(Boolean).slice(0, 4);
  if (!ids.length) return [];
  const chain = [];
  const seen = new Set([String(profile.user)]); // never let someone approve their own leave
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const u = await User.findById(id).select('firstName lastName role isActive');
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

/**
 * The ladder a LEAVE request should climb.
 *
 * Prefers the configured `leaveApprovers` ladder; falls back to the org-chart
 * walk (`buildApprovalChain`) when the employee has not been configured. That
 * fallback is why this is a separate function rather than a change inside
 * `buildApprovalChain` — that builder is also used by the exit/resignation flow
 * (controllers/exitController.js), which must keep walking reportingManager
 * regardless of how leave is configured.
 */
async function buildLeaveChain(profile) {
  const configured = await buildConfiguredLeaveChain(profile);
  if (configured.length) return configured;
  return buildApprovalChain(profile);
}

// Every leaveType already ends in the word "Leave" ("Paid Leave", "Unpaid
// Leave", "Emergency Leave", "Maternity Leave"), so the long-standing
// `${leaveType} leave` interpolation rendered "Paid Leave leave" in every
// notification this module sends. Build the phrase with this instead.
const leaveLabel = (t) => {
  const s = String(t || '').trim();
  if (!s) return 'leave';
  return /leave$/i.test(s) ? s : `${s} leave`;
};

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
      audience: 'admin',
      title: 'Leave needs your approval',
      body: `${applicantName} applied for ${leaveLabel(request.leaveType)} (${request.totalDays}d) - it's awaiting your approval.`,
      link: 'leave',
    });
    const appr = await User.findById(approverUserId).select('email');
    if (appr?.email) {
      await enqueueMail(
        {
          to: [appr.email],
          subject: `Leave approval needed - ${applicantName} (${request.leaveType}, ${request.totalDays}d)`,
          text: [
            `${applicantName} has a ${leaveLabel(request.leaveType)} request (${request.totalDays} day(s)) awaiting your approval.`,
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
      audience: 'employee',
      title: approved ? 'Leave approved' : 'Leave rejected',
      body: `Your ${leaveLabel(request.leaveType)} (${days}) has been ${approved ? 'approved' : 'rejected'}.${note ? ` Note: ${note}` : ''}`,
      link: 'leave',
    });
  } catch (err) {
    console.error('leave decision notify failed:', err.message);
  }
}

// Heads-up to every approver ABOVE the first rung when a request is filed, so
// the whole ladder knows it is coming rather than only hearing about it at the
// moment it lands in their inbox. Informational — `notifyApprover` is still what
// tells someone it is actually their turn.
async function notifyChainQueued(request, chain, applicantName) {
  try {
    const upper = (chain || []).filter((s) => s.order > 0 && s.approver);
    if (!upper.length) return;
    const first = chain[0];
    const total = chain.length;
    await notifyMany(
      upper.map((s) => s.approver),
      {
        type: 'leave',
        audience: 'admin',
        title: 'Leave awaiting approval below you',
        body: `${applicantName} applied for ${leaveLabel(request.leaveType)} (${request.totalDays}d). You are in the approval chain - it is with ${first.approverName || 'their manager'} first (step 1 of ${total}).`,
        link: 'leave',
      }
    );
  } catch (err) {
    console.error('chain-queued notify failed:', err.message);
  }
}

// Tell the applicant that ONE rung of the ladder has decided, while the request
// is still travelling. Without this the employee heard nothing between applying
// and the final decision, which on a 3-rung chain can be days of silence.
async function notifyEmployeeStep(request, step, next, note) {
  try {
    const prof = await EmployeeProfile.findById(request.employee).select('user');
    if (!prof?.user) return;
    const total = (request.approvalChain || []).length;
    const stepNo = (step?.order ?? 0) + 1;
    const days = `${request.totalDays} day${request.totalDays === 1 ? '' : 's'}`;
    await notify({
      recipient: prof.user,
      type: 'leave',
      audience: 'employee',
      title: `Leave approved at step ${stepNo} of ${total}`,
      body: `${step?.approverName || 'Your manager'} approved your ${leaveLabel(request.leaveType)} (${days}). It now needs ${next?.approverName || 'the next approver'}'s approval.${note ? ` Note: ${note}` : ''}`,
      link: 'leave',
    });
  } catch (err) {
    console.error('leave step notify failed:', err.message);
  }
}

// Tell the applicant, at submit time, WHO the request is with and how long the
// ladder is. Without this the employee only heard from step 2 onward
// (notifyEmployeeStep fires on a decision), so on a 1-step chain they were told
// nothing at all until the outcome.
async function notifyEmployeeSubmitted(request, chain) {
  try {
    const prof = await EmployeeProfile.findById(request.employee).select('user');
    if (!prof?.user) return;
    const total = chain.length;
    const days = `${request.totalDays} day${request.totalDays === 1 ? '' : 's'}`;
    await notify({
      recipient: prof.user,
      type: 'leave',
      audience: 'employee',
      title: `Leave submitted — step 1 of ${total}`,
      body: `Your ${leaveLabel(request.leaveType)} (${days}) is awaiting ${chain[0]?.approverName || 'your approver'}'s approval${total > 1 ? `, the first of ${total} steps` : ''}.`,
      link: 'leave',
    });
  } catch (err) {
    console.error('leave submitted notify failed:', err.message);
  }
}

// Tell approvers who still had (or were waiting for) their turn that the request
// left the ladder — cancelled by the employee, or force-decided by HR — so it
// doesn't sit in their inbox as a ghost.
async function notifyChainVoided(request, voidedSteps, reason) {
  try {
    const ids = (voidedSteps || []).filter((s) => s.approver).map((s) => s.approver);
    if (!ids.length) return;
    const name = await applicantNameOf(request);
    await notifyMany(ids, {
      type: 'leave',
      audience: 'admin',
      title: `Leave ${reason}`,
      body: `${name}'s ${leaveLabel(request.leaveType)} (${request.totalDays}d) was ${reason} - no action is needed from you.`,
      link: 'leave',
    });
  } catch (err) {
    console.error('chain-voided notify failed:', err.message);
  }
}

// HR is informed (not an approval rung): the whole HR team hears about EVERY
// status change a request goes through — applied, fully approved, rejected,
// cancelled, HR override.
//
// Recipients are resolved by capability (`leave.manage`) rather than by role or
// by the per-employee hrPartner, so the list stays in step with
// config/permissions.js. That matters: hrPartner is set on only a minority of
// profiles (the web employee form stopped sending it), so the old
// "hrPartner + oldest SuperAdmin" rule silently skipped the actual HR Managers.
//
// Two exclusions keep it from being noise: anyone on the approval chain already
// got a specific message about their own rung, and nobody needs a notification
// about an action they just performed themselves.
async function notifyHrInformational(request, verb, actorId, excludeIds = []) {
  try {
    const prof = await EmployeeProfile.findById(request.employee)
      .select('user hrPartner company')
      .populate('user', 'firstName lastName');
    const ids = new Set();
    // Walled to the employee's company — company B's HR does not hear about
    // company A's leave.
    const holders = await scopeRecipientsToCompany(await usersHoldingAny('leave.manage'), prof?.company);
    for (const id of holders) ids.add(String(id));
    if (prof?.hrPartner) ids.add(String(prof.hrPartner));
    // Safety net: never let a status change go completely unheard.
    if (!ids.size) {
      const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
      if (sa) ids.add(String(sa._id));
    }
    for (const s of request.approvalChain || []) {
      if (s.approver) ids.delete(String(s.approver));
    }
    if (actorId) ids.delete(String(actorId));
    const applicantUserId = prof?.user?._id || prof?.user;
    if (applicantUserId) ids.delete(String(applicantUserId));
    // Anyone who already got a more specific notice about this same event.
    for (const id of excludeIds) ids.delete(String(id));
    if (!ids.size) return;
    const name = `${prof?.user?.firstName || ''} ${prof?.user?.lastName || ''}`.trim() || 'An employee';
    const days = `${request.totalDays}d`;
    await notifyMany([...ids], {
      type: 'leave',
      audience: 'admin',
      title: `Leave ${verb}`,
      body:
        verb === 'applied'
          ? `${name} applied for ${leaveLabel(request.leaveType)} (${days}). It has entered the reporting-hierarchy approval chain.`
          : `${name}'s ${leaveLabel(request.leaveType)} (${days}) was ${verb}.`,
      link: 'leave',
    });
  } catch (err) {
    console.error('HR informational notify failed:', err.message);
  }
}

/**
 * The "leave is fully approved" notice to HR — a fuller message than the generic
 * status line `notifyHrInformational` sends, because this is the one HR acts on
 * (payroll split, roster cover). Carries type, dates, day count and the
 * paid/LOP split, plus who gave the final sign-off.
 *
 * Audience: the SuperAdmin-configured `leaveFinalHrRecipients` for THIS employee
 * when set — an explicit choice, so chain members are not filtered out of it.
 * With none configured it falls back to the same capability-based audience the
 * other leave notices use, with the usual exclusions.
 *
 * `configuredOnly` suppresses that fallback, for the HR-override path where a
 * generic notice is already going to the derived audience and only the named
 * recipients still need the detailed one.
 *
 * @returns {Promise<string[]>} the user ids actually notified, so a caller can
 *   exclude them from a second notice and avoid double-notifying.
 */
async function notifyHrFinalApproval(request, actorId, { configuredOnly = false } = {}) {
  try {
    const prof = await EmployeeProfile.findById(request.employee)
      .select('user hrPartner leaveFinalHrRecipients employeeCode department company')
      .populate('user', 'firstName lastName');

    const configured = (prof?.leaveFinalHrRecipients || []).map(String).filter(Boolean);
    const ids = new Set();
    if (configured.length) {
      for (const id of configured) ids.add(id);
    } else if (configuredOnly) {
      return [];
    } else {
      // Same company wall as the generic notice above.
      for (const id of await scopeRecipientsToCompany(await usersHoldingAny('leave.manage'), prof?.company)) ids.add(String(id));
      if (prof?.hrPartner) ids.add(String(prof.hrPartner));
      if (!ids.size) {
        const sa = await User.findOne({ role: 'SuperAdmin', isActive: true })
          .sort({ createdAt: 1 })
          .select('_id');
        if (sa) ids.add(String(sa._id));
      }
      // Only the derived audience gets these exclusions — a named recipient was
      // chosen deliberately and should hear about it even if they also approved.
      for (const s of request.approvalChain || []) {
        if (s.approver) ids.delete(String(s.approver));
      }
    }
    if (actorId) ids.delete(String(actorId));
    const applicantUserId = prof?.user?._id || prof?.user;
    if (applicantUserId) ids.delete(String(applicantUserId));
    if (!ids.size) return [];

    const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const name = `${prof?.user?.firstName || ''} ${prof?.user?.lastName || ''}`.trim() || 'An employee';
    const who = prof?.employeeCode ? `${name} (${prof.employeeCode})` : name;
    const span =
      String(request.startDate) === String(request.endDate)
        ? fmt(request.startDate)
        : `${fmt(request.startDate)} – ${fmt(request.endDate)}`;
    const half = request.isHalfDay ? ' half-day' : '';
    const split =
      request.lopDays > 0
        ? ` Paid ${request.paidDays}d, LOP ${request.lopDays}d.`
        : '';
    const approver = await User.findById(actorId).select('firstName lastName');
    const by = approver ? ` Final approval by ${`${approver.firstName || ''} ${approver.lastName || ''}`.trim()}.` : '';

    await notifyMany([...ids], {
      type: 'leave',
      audience: 'admin',
      title: 'Leave fully approved',
      body: `${who}${prof?.department ? ` · ${prof.department}` : ''} — ${leaveLabel(request.leaveType)}${half}, ${span} (${request.totalDays}d).${split}${by}`,
      link: 'leave',
    });
    return [...ids];
  } catch (err) {
    console.error('HR final-approval notify failed:', err.message);
    return [];
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
      audience: 'admin',
      title: 'Leave rejected below you',
      body: `${name}'s ${leaveLabel(request.leaveType)} was rejected by ${rejectedStep.approverName || 'a manager'} before it reached you.`,
      link: 'leave',
    });
  } catch (err) {
    console.error('chain-above notify failed:', err.message);
  }
}

// Self-heal: a Pending request may have NO approval chain — it was created before
// the hierarchy feature (or by an older running backend). Rebuild the chain live
// from the applicant's current org-chart hierarchy (reportingManager), set the
// first rung as the current approver, and notify them. Idempotent: does nothing
// once a chain/currentApprover exists, or when there is genuinely no manager
// (that request stays for the HR override). Returns true if it healed.
async function ensureApprovalChain(request) {
  if (!request || request.status !== 'Pending') return false;
  if (request.currentApprover || (request.approvalChain && request.approvalChain.length)) return false;
  const profile = await EmployeeProfile.findById(request.employee).select('user reportingManager leaveApprovers');
  if (!profile) return false;
  const chain = await buildLeaveChain(profile);
  if (!chain.length) return false; // no manager in the hierarchy → HR decides
  chain[0].status = 'Pending';
  request.approvalChain = chain;
  request.currentApprover = chain[0].approver;
  await request.save();
  try {
    await notifyApprover(chain[0].approver, request, await applicantNameOf(request));
  } catch (err) {
    console.error('ensureApprovalChain notify failed:', err.message);
  }
  return true;
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
          `Reason     : ${request.reason || '-'}`,
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
  const key = balanceBucketFor(leaveType);
  if (!key) return;
  const bucket = balance.balances[key];
  if (!bucket) return;
  bucket.used = (bucket.used || 0) + delta;
  bucket.balance = (bucket.balance || 0) - delta;
}

// ===== Monthly paid-leave quota (2 days/month, extra → LOP) =====

// The IST-midnight instants covered by [start, end] inclusive.
function eachDayInclusive(startDate, endDate) {
  const days = [];
  let cur = startOfDayIST(startDate);
  const last = startOfDayIST(endDate).getTime();
  let guard = 0;
  while (cur.getTime() <= last && guard < 400) {
    guard += 1;
    days.push(cur);
    cur = startOfDayIST(new Date(cur.getTime() + 24 * 60 * 60 * 1000)); // +1 day (IST has no DST)
  }
  return days;
}

// Working days (Sundays + holidays excluded) covered by [start, end], grouped by
// IST calendar month → { 'YYYY-MM': ['YYYY-MM-DD', …] } in chronological order.
// These are the only days that carry a pay effect (matches attendance stamping).
// `excluded` drops further day keys — the days the employee worked through their
// own leave and had given back (LeaveRequest.workedDays), which must not count
// against the paid quota or be re-stamped as leave.
async function workingDaysByMonth(startDate, endDate, excluded = []) {
  const days = eachDayInclusive(startDate, endDate);
  if (!days.length) return {};
  const holidays = await Holiday.find({ date: { $gte: days[0], $lte: days[days.length - 1] } })
    .select('date').lean().catch(() => []);
  const holidayKeys = new Set((holidays || []).map((h) => ymdIST(h.date)));
  const workedKeys = new Set((excluded || []).map(String));
  const byMonth = {};
  for (const d of days) {
    const key = ymdIST(d);
    const [Y, M, D] = key.split('-').map(Number);
    if (new Date(Date.UTC(Y, M - 1, D)).getUTCDay() === 0) continue; // Sunday
    if (holidayKeys.has(key)) continue;                              // holiday
    if (workedKeys.has(key)) continue;                               // worked, given back
    const ym = `${Y}-${String(M).padStart(2, '0')}`;
    (byMonth[ym] ||= []).push(key);
  }
  return byMonth;
}

// Count of PAID leave days already committed in an IST month `ym` ('YYYY-MM') for
// an employee, so a new request knows how much of the 2-day quota is left. Sums
// (a) already-approved leave days stamped OnLeave on the calendar, plus (b) the
// working days of the employee's other still-Pending non-LOP requests overlapping
// the month (excluding `excludeRequestId`). (b) is a conservative estimate that
// protects the quota when several requests are queued at once.
async function paidLeaveUsedInMonth(employeeId, ym, excludeRequestId = null) {
  const [Y, M] = ym.split('-').map(Number);
  const { start, end } = monthRangeIST(Y, M); // [start, end)
  const stamped = await Attendance.countDocuments({
    employee: employeeId,
    status: 'OnLeave',
    date: { $gte: start, $lt: end },
  });
  const pendFilter = {
    employee: employeeId,
    status: 'Pending',
    // Deliberately-unpaid leave never touches the quota, so a queued one must
    // not reserve paid days. Both the current name and the retired code.
    leaveType: { $nin: [UNPAID_LEAVE, 'LOP'] },
    startDate: { $lt: end },
    endDate: { $gte: start },
  };
  if (excludeRequestId) pendFilter._id = { $ne: excludeRequestId };
  const pending = await LeaveRequest.find(pendFilter).select('startDate endDate isHalfDay workedDays').lean();
  let pendingDays = 0;
  for (const r of pending) {
    const byMonth = await workingDaysByMonth(r.startDate, r.endDate, r.workedDays);
    const n = byMonth[ym]?.length || 0;
    pendingDays += r.isHalfDay ? Math.min(0.5, n) : n;
  }
  return stamped + pendingDays;
}

// Split a leave request's working days into PAID vs LOP under the monthly quota.
// - Unpaid Leave    → every day is LOP (explicitly unpaid, no cap).
// - Maternity Leave → every day is paid (not subject to the monthly cap).
// - Paid / Emergency → the first (quota − alreadyUsed) working days of each
//   calendar month are paid; the rest become LOP. So an employee always spends
//   their paid days first, and a request longer than what is left of the quota
//   turns unpaid for the remainder by itself. The quota is 2/month, prorated for
//   a month the employee only worked part of (joined or exited mid-month).
// Returns day counts plus the set of LOP day-keys and a per-month breakdown so
// the calendar can be stamped and the employee shown the split at apply time.
async function computeLeaveSplit(employeeId, { leaveType, startDate, endDate, isHalfDay, workedDays }, excludeRequestId = null) {
  const byMonth = await workingDaysByMonth(startDate, endDate, workedDays);
  const months = Object.keys(byMonth).sort();
  const workingKeys = months.flatMap((ym) => byMonth[ym]);
  const half = !!isHalfDay;
  // Half-day requests cover a single day counted as 0.5.
  const weightOf = () => (half ? 0.5 : 1);

  const lopKeys = new Set();
  const perMonth = [];
  let paidDays = 0;
  let lopDays = 0;

  if (isUnpaidType(leaveType)) {
    for (const key of workingKeys) lopKeys.add(key);
    lopDays = half ? Math.min(0.5, workingKeys.length) : workingKeys.length;
    return { paidDays: 0, lopDays, lopKeys, workingKeys, perMonth };
  }
  if (isMaternityType(leaveType)) {
    paidDays = half ? Math.min(0.5, workingKeys.length) : workingKeys.length;
    return { paidDays, lopDays: 0, lopKeys, workingKeys, perMonth };
  }

  // Joining / exit dates decide how much of each month's quota this employee has.
  const emp = await EmployeeProfile.findById(employeeId).select('dateOfJoining dateOfExit').lean();
  for (const ym of months) {
    const quota = monthlyQuotaFor(emp, ym);
    const used = await paidLeaveUsedInMonth(employeeId, ym, excludeRequestId);
    let remaining = Math.max(0, quota - used);
    let monthPaid = 0;
    let monthLop = 0;
    for (const key of byMonth[ym]) {
      const w = weightOf();
      // A calendar day is stamped atomically (OnLeave or Absent), so it is paid
      // only when the whole day's weight fits in the remaining quota.
      if (remaining >= w) {
        remaining -= w;
        monthPaid += w;
        paidDays += w;
      } else {
        lopKeys.add(key);
        monthLop += w;
        lopDays += w;
      }
    }
    perMonth.push({ ym, working: byMonth[ym].length, alreadyUsed: used, quota, paid: monthPaid, lop: monthLop });
  }
  return { paidDays, lopDays, lopKeys, workingKeys, perMonth };
}

// Paid leave days actually taken (stamped OnLeave) in an IST month — for the
// employee's dashboard "used this month" figure (approved leave only).
async function stampedPaidLeaveInMonth(employeeId, year, month) {
  const { start, end } = monthRangeIST(year, month);
  return Attendance.countDocuments({
    employee: employeeId,
    status: 'OnLeave',
    date: { $gte: start, $lt: end },
  });
}

// ===== Emergency leave =====
// Granted the instant it is filed — no approval ladder. Everyone up the
// reporting hierarchy (plus HR) is INFORMED rather than asked, and repeats are
// policed after the fact: from the EMERGENCY_FLAG_FROM'th in a calendar month
// the notice is escalated to a flag, and any of those managers (or HR) can then
// charge that day at double via setDoubleCut.

// How many emergency leaves this employee already has in the IST month of
// `date`. Cancelled / rejected ones don't count.
async function countEmergencyInMonth(employeeId, date, excludeRequestId = null) {
  const [Y, M] = ymdIST(date).split('-').map(Number);
  const { start, end } = monthRangeIST(Y, M);
  const filter = {
    employee: employeeId,
    leaveType: EMERGENCY_LEAVE,
    status: { $in: ['Approved', 'Pending'] },
    startDate: { $gte: start, $lt: end },
  };
  if (excludeRequestId) filter._id = { $ne: excludeRequestId };
  return LeaveRequest.countDocuments(filter);
}

// Tell the hierarchy + HR. Best-effort: never blocks the leave being granted.
// Returns the names of the people informed, so the employee sees who was told.
async function notifyEmergencyTaken(request, profile, chain) {
  const names = chain.map((s) => s.approverName).filter(Boolean);
  try {
    const ids = new Set(chain.filter((s) => s.approver).map((s) => String(s.approver)));
    if (profile.hrPartner) ids.add(String(profile.hrPartner));
    const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
    if (sa) ids.add(String(sa._id));
    if (!ids.size) return names;

    const who = await applicantNameOf(request);
    const days = `${request.totalDays} day${request.totalDays === 1 ? '' : 's'}`;
    const nth = request.emergencyIndexInMonth;
    const flagged = request.emergencyFlagged;
    await notifyMany([...ids], {
      type: 'leave',
      audience: 'admin',
      title: flagged ? 'Repeat emergency leave — please review' : 'Emergency leave taken',
      body: flagged
        ? `${who} has now taken emergency leave ${nth} times this month (latest ${days}). It needed no approval, but repeat use is flagged — you can charge the day at double pay from the leave record.`
        : `${who} has taken emergency leave (${days}). Emergency leave needs no approval — you're being informed.`,
      link: 'leave',
    });

    // Email the same people, so it reaches them even if they aren't in the app.
    const users = await User.find({ _id: { $in: [...ids] } }).select('email');
    const to = users.map((u) => u.email).filter(Boolean);
    if (to.length) {
      const fmt = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      await enqueueMail(
        {
          to,
          subject: flagged
            ? `Repeat emergency leave — ${who} (${nth} this month)`
            : `Emergency leave — ${who} (${days})`,
          text: [
            `${who} has taken emergency leave. No approval is required for it; this is to inform you.`,
            '',
            `Dates      : ${fmt(request.startDate)}${request.isHalfDay ? ' (half day)' : ` – ${fmt(request.endDate)}`}`,
            `Total days : ${request.totalDays}`,
            `Reason     : ${request.reason || '-'}`,
            `This month : emergency leave #${nth}`,
            '',
            flagged
              ? 'This is a repeat within the same month and has been flagged. If it is being misused, you or HR can apply a double salary cut for that day from the leave record in the portal.'
              : 'No action is needed.',
          ].join('\n'),
        },
        { type: 'leave', id: request._id }
      );
    }
  } catch (err) {
    console.error('emergency leave notify failed:', err.message);
  }
  return names;
}

// Create + grant an emergency leave in one step, then inform everyone.
async function grantEmergencyLeave(profile, data) {
  const { leaveType, startDate, endDate, isHalfDay, halfDaySession, totalDays, reason, split } = data;
  const now = new Date();
  // The ladder is recorded so the request still shows WHO was informed, with
  // every rung marked Skipped — nobody's decision was ever required.
  const chain = (await buildLeaveChain(profile)).map((s) => ({
    ...s,
    status: 'Skipped',
    decidedAt: now,
    note: 'Informed — emergency leave is granted without approval',
  }));
  const indexInMonth = (await countEmergencyInMonth(profile._id, startDate)) + 1;

  const request = await LeaveRequest.create({
    employee: profile._id,
    leaveType,
    startDate,
    endDate,
    isHalfDay: !!isHalfDay,
    halfDaySession,
    totalDays,
    paidDays: split.paidDays,
    lopDays: split.lopDays,
    reason,
    status: 'Approved',
    approvalChain: chain,
    currentApprover: null,
    decisionAt: now,
    decisionNote: 'Emergency leave — granted on filing; reporting hierarchy and HR informed',
    emergencyIndexInMonth: indexInMonth,
    emergencyFlagged: indexInMonth >= EMERGENCY_FLAG_FROM,
  });

  // Put it on the calendar straight away (paid days OnLeave, beyond-quota days
  // Absent) — same treatment an approved Paid Leave gets.
  await stampLeaveAttendance(request);
  const informedNames = await notifyEmergencyTaken(request, profile, chain);
  return { request, informedNames };
}

// ===== Employee self-service =====

/**
 * Get the caller's leave balance for a year (creates one if absent).
 * @route GET /api/leave/me/balance?year=
 * @param {number} [req.query.year] - defaults to current year
 * @returns {{balance: Object}}
 */
// GET /api/leave/me/balance?year=
const getMyBalance = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const year = Number(req.query.year) || currentYear();
  const balance = await getOrCreateBalance(profile._id, year);

  // Monthly paid-leave quota status for the current IST month (2 paid days/month,
  // extra → LOP). Drives the dashboard/leave-page "this month" indicator. The
  // quota is prorated in the month the employee joined (or exits).
  const [nowY, nowM] = ymdIST().split('-').map(Number);
  const usedThisMonth = await stampedPaidLeaveInMonth(profile._id, nowY, nowM);
  const { daysInMonth, eligibleDays } = daysOnPayroll(profile, nowY, nowM);
  const quota = prorateAllowance(MONTHLY_PAID_LEAVE, eligibleDays, daysInMonth);
  const monthly = {
    year: nowY,
    month: nowM,
    quota,
    fullQuota: MONTHLY_PAID_LEAVE,
    prorated: eligibleDays < daysInMonth,
    daysInMonth,
    eligibleDays,
    used: usedThisMonth,
    remaining: Math.max(0, quota - usedThisMonth),
  };

  const out = balance.toObject();
  out.monthly = monthly;
  res.json({ balance: out, monthly });
});

/**
 * List the caller's own leave requests, newest first.
 * @route GET /api/leave/me/requests
 * @returns {{count: number, requests: Object[]}} with populated approver
 */
// GET /api/leave/me/requests
const listMyRequests = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const requests = await LeaveRequest.find({ employee: profile._id })
    .populate('approver', 'firstName lastName role')
    .sort({ appliedAt: -1 });
  res.json({ count: requests.length, requests });
});

/**
 * Apply for leave; builds the approval ladder and notifies the first approver
 * (or HR when there is no reporting manager).
 * @route POST /api/leave/me/requests
 * @param {string} req.body.leaveType - one of LEAVE_TYPES (required)
 * @param {string} req.body.startDate - required
 * @param {string} req.body.endDate - required
 * @param {boolean} [req.body.isHalfDay] - if set, start==end and totalDays=0.5
 * @param {string} [req.body.halfDaySession] - FirstHalf|SecondHalf (required for half-day)
 * @param {string} [req.body.reason]
 * @returns {{request: Object}} (201)
 */
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

  // Apply the monthly paid-leave quota (2 paid days/calendar month) up front so
  // the record — and the employee — know how much of this request is LOP.
  const split = await computeLeaveSplit(profile._id, { leaveType, startDate, endDate, isHalfDay }, null);

  // Emergency leave needs nobody's approval — it is granted the moment it is
  // filed, and the hierarchy is informed instead of asked.
  if (isEmergencyType(leaveType)) {
    const granted = await grantEmergencyLeave(profile, {
      leaveType, startDate, endDate, isHalfDay, halfDaySession, totalDays, reason, split,
    });
    return res.status(201).json({
      request: granted.request,
      emergency: {
        indexInMonth: granted.request.emergencyIndexInMonth,
        flagged: granted.request.emergencyFlagged,
        informed: granted.informedNames,
      },
      split: { paidDays: split.paidDays, lopDays: split.lopDays, perMonth: split.perMonth },
    });
  }

  // Build the approval ladder — the configured `leaveApprovers` if this employee
  // has one, otherwise the reportingManager walk. The first rung is Pending
  // (their turn); the rest wait. Empty chain = nobody to ask → HR decides.
  const chain = await buildLeaveChain(profile);
  if (chain.length) chain[0].status = 'Pending';

  const request = await LeaveRequest.create({
    employee: profile._id,
    leaveType,
    startDate,
    endDate,
    isHalfDay: !!isHalfDay,
    halfDaySession,
    totalDays,
    paidDays: split.paidDays,
    lopDays: split.lopDays,
    reason,
    approvalChain: chain,
    currentApprover: chain.length ? chain[0].approver : null,
  });

  const applicantName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'An employee';
  if (chain.length) {
    // The first rung gets the actionable "your turn" nudge; everyone above gets a
    // heads-up so the whole approval hierarchy is in the loop from the start.
    await notifyApprover(chain[0].approver, request, applicantName);
    await notifyChainQueued(request, chain, applicantName);
    // ...and the employee is told where it landed, so every rung of the ladder
    // produces a notification for them (submit here, each decision via
    // notifyEmployeeStep, the outcome via notifyEmployeeDecision).
    await notifyEmployeeSubmitted(request, chain);
    // HR sees the request the moment it is filed, not only at the outcome.
    await notifyHrInformational(request, 'applied', req.user._id);
  } else {
    // No manager in the hierarchy — fall back to HR/SuperAdmin to force-decide.
    await emailLeaveToHr(profile, request, req.user);
    try {
      const sa = await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id');
      if (sa) {
        await notify({
          recipient: sa._id,
          type: 'leave',
          audience: 'admin',
          title: 'Leave needs a decision',
          body: `${applicantName} applied for ${leaveLabel(request.leaveType)} (${request.totalDays}d) but has no reporting manager - please review.`,
          link: 'leave',
        });
      }
    } catch (err) {
      console.error('no-chain HR notify failed:', err.message);
    }
  }

  res.status(201).json({ request, split: { paidDays: split.paidDays, lopDays: split.lopDays, perMonth: split.perMonth } });
});

/**
 * Preview the paid-vs-LOP split for a would-be leave request without creating it.
 * Lets the apply form show, live, how many days will be Loss of Pay under the
 * 2/month quota.
 * @route GET /api/leave/me/leave-preview?leaveType=&startDate=&endDate=&isHalfDay=
 * @returns {{paidDays, lopDays, quota, perMonth}}
 */
// GET /api/leave/me/leave-preview
const previewLeave = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const { leaveType, startDate, endDate, isHalfDay } = req.query;
  if (!leaveType || !startDate || !endDate) {
    res.status(400);
    throw new Error('leaveType, startDate, endDate are required');
  }
  if (!LEAVE_TYPES.includes(leaveType)) {
    res.status(400);
    throw new Error(`Invalid leaveType. Allowed: ${LEAVE_TYPES.join(', ')}`);
  }
  const half = isHalfDay === 'true' || isHalfDay === '1' || isHalfDay === true;
  const split = await computeLeaveSplit(profile._id, { leaveType, startDate, endDate, isHalfDay: half }, null);
  res.json({
    paidDays: split.paidDays,
    lopDays: split.lopDays,
    // The quota actually applied to the first month covered (prorated in a
    // part-month); split.perMonth carries it per month.
    quota: split.perMonth.length ? split.perMonth[0].quota : MONTHLY_PAID_LEAVE,
    fullQuota: MONTHLY_PAID_LEAVE,
    perMonth: split.perMonth,
  });
});

/**
 * Apply / lift the double salary cut on a flagged emergency leave. Open to HR
 * (leave.manage) and to any manager on that employee's reporting ladder — the
 * same people the emergency leave was reported to.
 * @route PATCH /api/leave/emergency/:id/double-cut  (manager or leave.manage)
 * @param {string} req.params.id - leave request id
 * @param {boolean} [req.body.apply=true] - false lifts a cut already applied
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 * @sideeffect notifies the employee; the month's payroll then deducts 2× that day
 */
const setDoubleCut = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  if (!isEmergencyType(request.leaveType)) {
    res.status(400);
    throw new Error('A double salary cut only applies to emergency leave.');
  }
  if (request.status !== 'Approved') {
    res.status(400);
    throw new Error(`This emergency leave is ${request.status} — nothing to charge.`);
  }

  // Either HR (leave.manage) or someone on this employee's reporting ladder.
  const onLadder = (request.approvalChain || [])
    .some((s) => s.approver && String(s.approver) === String(req.user._id));
  const isHrActor = hasPermission(req.user, 'leave.manage');
  if (!isHrActor && !onLadder) {
    res.status(403);
    throw new Error('Only this employee\'s managers or HR can charge an emergency leave double.');
  }
  // An HR Manager acting purely as HR (not sitting on this employee's ladder)
  // may only touch their own assigned employees. A ladder approver keeps their
  // authority regardless of who the employee is partnered with.
  if (isHrActor && !onLadder) {
    const dcProfile = await EmployeeProfile.findById(request.employee).select('hrPartner company');
    if (cannotManageProfile(req, dcProfile)) {
      res.status(403);
      throw new Error('You can only manage employees assigned to you');
    }
  }

  const apply = req.body.apply !== false;
  request.doubleCut = apply;
  request.doubleCutBy = apply ? req.user._id : null;
  request.doubleCutByName = apply
    ? (req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim())
    : undefined;
  request.doubleCutAt = apply ? new Date() : undefined;
  request.doubleCutNote = apply ? String(req.body.note || '').trim() : undefined;
  await request.save();

  // Tell the employee either way — this costs them a day's pay, so it must not
  // be a surprise on the payslip.
  try {
    const prof = await EmployeeProfile.findById(request.employee).select('user');
    if (prof?.user) {
      await notify({
        recipient: prof.user,
        type: 'leave',
        audience: 'employee',
        title: apply ? 'Emergency leave charged at double' : 'Double cut on emergency leave lifted',
        body: apply
          ? `Your emergency leave (${request.totalDays} day${request.totalDays === 1 ? '' : 's'}) has been charged at double pay by ${request.doubleCutByName || 'your manager'}.${request.doubleCutNote ? ` Note: ${request.doubleCutNote}` : ''}`
          : `The double salary cut on your emergency leave (${request.totalDays} day${request.totalDays === 1 ? '' : 's'}) has been removed.`,
        link: 'leave',
      });
    }
  } catch (err) {
    console.error('double-cut notify failed:', err.message);
  }

  res.json({ request });
});

/**
 * Cancel the caller's own leave request (not once it has started).
 * @route PATCH /api/leave/me/requests/:id/cancel
 * @param {string} req.params.id - request id
 * @returns {{request: Object}} with status Cancelled
 * @sideeffect if it was Approved, restores the balance and un-stamps the calendar
 */
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

  // A double salary cut has already been decided against this emergency leave —
  // cancelling would erase the penalty (payroll only counts Approved ones), so
  // only the manager/HR who applied it can lift it first.
  if (request.doubleCut) {
    res.status(400);
    throw new Error('This emergency leave has been charged at double pay and cannot be cancelled. Ask your manager or HR to lift the double cut first.');
  }

  // Once the leave has begun (its start date is in the past), it can no longer
  // be cancelled — the day has been taken. Compare date-only so a leave starting
  // today is still cancellable.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (new Date(request.startDate) < startOfToday) {
    res.status(400);
    throw new Error('This leave has already started and can no longer be cancelled');
  }

  // If it was already approved, restore the balance (deducted only at final
  // approval) and remove the auto-stamped leave days from the calendar.
  if (request.status === 'Approved') {
    const year = new Date(request.startDate).getFullYear();
    const balance = await getOrCreateBalance(profile._id, year);
    adjustBalance(balance, request.leaveType, -request.totalDays);
    await balance.save();
    await unstampLeaveAttendance(request);
  }

  // Stop the approval ladder: no one's turn any more, pending/waiting rungs void.
  request.currentApprover = null;
  const stranded = (request.approvalChain || []).filter(
    (s) => s.status === 'Pending' || s.status === 'Waiting'
  );
  for (const s of request.approvalChain || []) {
    if (s.status === 'Pending' || s.status === 'Waiting') s.status = 'Skipped';
  }
  request.status = 'Cancelled';
  request.decisionAt = new Date();
  await request.save();
  // Clear it out of the inbox of whoever was holding it, and tell HR the status
  // changed — a withdrawn request is as much a status change as a decision.
  await notifyChainVoided(request, stranded, 'cancelled by the employee');
  await notifyHrInformational(request, 'cancelled', req.user._id);
  res.json({ request });
});

// ===== HR/Admin endpoints =====

/**
 * List all leave requests with optional filters (admin).
 * @route GET /api/leave/requests?employee=&status=&from=&to=
 * @param {string} [req.query.employee] / [req.query.status] / [req.query.from] / [req.query.to]
 * @returns {{count: number, requests: Object[]}} with populated employee/approver
 */
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
  // Limit to the employees this admin may see (HR Manager → assigned, exec →
  // their companies; also intersects a specific ?employee= against that scope).
  await scopeEmployeeFilter(req, filter);
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
  const key = balanceBucketFor(request.leaveType);
  if (!key) return;
  const year = new Date(request.startDate).getFullYear();
  const balance = await getOrCreateBalance(request.employee, year);
  const available = balance.balances[key]?.balance || 0;
  if (available < request.totalDays) {
    const err = new Error(`Insufficient ${request.leaveType} balance (have ${available}, need ${request.totalDays})`);
    err.status = 400;
    throw err;
  }
  adjustBalance(balance, request.leaveType, request.totalDays);
  await balance.save();
}

// ===== Auto-stamp approved leave onto the attendance calendar =====
// When a leave is finally approved, mark each covered working day so it shows on
// the attendance calendar and feeds the payroll leave-quota rule (2 paid/month).
// Sundays and holidays are skipped, and a day the employee actually worked
// (has a check-in) is never overwritten. LOP leave is stamped Absent (unpaid);
// every other type is stamped OnLeave (counts toward the paid quota).
const LEAVE_AUTO_REMARK = 'Auto-stamped from approved leave';

// The list of IST-midnight instants covered by a request's [startDate, endDate].
function eachLeaveDay(request) {
  const days = [];
  let cur = startOfDayIST(request.startDate);
  const last = startOfDayIST(request.endDate).getTime();
  let guard = 0;
  while (cur.getTime() <= last && guard < 400) {
    guard += 1;
    days.push(cur);
    cur = startOfDayIST(new Date(cur.getTime() + 24 * 60 * 60 * 1000)); // +1 day (IST has no DST)
  }
  return days;
}

async function stampLeaveAttendance(request) {
  try {
    // Re-run the quota split at approval time (authoritative — other leave in the
    // month may have been approved since apply). Paid days → OnLeave (count toward
    // the 2/month quota); LOP days → Absent (unpaid). Persist the final split back
    // onto the request so payslip/reporting reflect what was actually granted.
    const split = await computeLeaveSplit(
      request.employee,
      {
        leaveType: request.leaveType,
        startDate: request.startDate,
        endDate: request.endDate,
        isHalfDay: request.isHalfDay,
        // Days already worked back never return to the calendar as leave.
        workedDays: request.workedDays,
      },
      request._id
    );
    if (request.paidDays !== split.paidDays || request.lopDays !== split.lopDays) {
      request.paidDays = split.paidDays;
      request.lopDays = split.lopDays;
      try { await request.save(); } catch (_) { /* best-effort */ }
    }
    if (!split.workingKeys.length) return;

    const remark = `${LEAVE_AUTO_REMARK} (${request.leaveType})`;
    for (const key of split.workingKeys) {
      const day = startOfDayIST(`${key}T00:00:00+05:30`);
      const stampStatus = split.lopKeys.has(key) ? 'Absent' : 'OnLeave';
      const existing = await Attendance.findOne({ employee: request.employee, date: day });
      if (existing) {
        if (existing.checkIn) continue;              // actually worked — respect reality
        if (existing.status === stampStatus) continue;
        existing.status = stampStatus;
        existing.remarks = remark;
        await existing.save();
      } else {
        await Attendance.create({ employee: request.employee, date: day, status: stampStatus, remarks: remark });
      }
    }
  } catch (err) {
    console.error('stampLeaveAttendance failed:', err.message);
  }
}

// Reverse of stampLeaveAttendance: drop the auto-stamped days when an approved
// leave is cancelled. Only removes our own marks on un-worked days.
async function unstampLeaveAttendance(request) {
  try {
    for (const day of eachLeaveDay(request)) {
      await Attendance.deleteOne({
        employee: request.employee,
        date: day,
        checkIn: null,
        status: { $in: ['OnLeave', 'Absent'] },
        remarks: new RegExp(`^${LEAVE_AUTO_REMARK}`),
      });
    }
  } catch (err) {
    console.error('unstampLeaveAttendance failed:', err.message);
  }
}

// ===== Working through your own leave =====
// An employee on approved leave who punches in anyway. The attendance side
// (controllers/attendanceController) owns the punch and the approval record;
// these three helpers are the leave-side knowledge it needs, and live here so
// the quota/stamping rules stay in one module.

/**
 * The APPROVED leave that covers an IST day and still claims it, or null.
 *
 * Excludes the cases where punching in is already the expected thing to do, so
 * no warning is raised for them:
 *   - a half-day leave (the employee is meant to work the other half),
 *   - a Sunday or a published holiday inside the range (a rest day worked is
 *     rest-day duty — the doublePay claim — not work on leave),
 *   - a day already worked back through this very flow.
 *
 * Date comparison note: startDate/endDate are cast from 'YYYY-MM-DD' and so sit
 * at UTC midnight, while `day` is IST midnight (5h30 earlier). Comparing against
 * [day, tomorrow) rather than `$lte: day` is what makes the first day of a leave
 * match — the same idiom presenceBoard uses.
 *
 * @param {ObjectId|string} employeeId - EmployeeProfile id
 * @param {Date} day - IST midnight of the day in question
 * @returns {Promise<Object|null>} the LeaveRequest document, or null
 */
async function leaveCoveringDay(employeeId, day) {
  const key = ymdIST(day);
  const [Y, M, D] = key.split('-').map(Number);
  if (new Date(Date.UTC(Y, M - 1, D)).getUTCDay() === 0) return null; // Sunday
  const tomorrow = new Date(startOfDayIST(day).getTime() + 24 * 60 * 60 * 1000);
  const request = await LeaveRequest.findOne({
    employee: employeeId,
    status: 'Approved',
    isHalfDay: false,
    startDate: { $lt: tomorrow },
    endDate: { $gte: startOfDayIST(day) },
    workedDays: { $ne: key },
  }).sort({ decisionAt: -1 });
  if (!request) return null;
  const holiday = await Holiday.findOne({ date: startOfDayIST(day) }).select('_id').lean().catch(() => null);
  if (holiday) return null;
  return request;
}

/**
 * The single person who decides whether a day worked on leave counts: the TOP
 * rung of this employee's leave hierarchy — the last step of the configured
 * `leaveApprovers` ladder, or the highest manager the org-chart walk reaches.
 *
 * Unlike a leave request this never climbs step by step: the employee has
 * already been granted the leave by the whole ladder, so only the person who had
 * the final say on it needs to rule on working through it. Falls back to the HR
 * partner and then the oldest active SuperAdmin so the claim is never stranded
 * with nobody able to act on it.
 *
 * @param {Object} profile - EmployeeProfile (needs user, reportingManager, leaveApprovers, hrPartner)
 * @returns {Promise<{approver: ObjectId, approverName: string}|null>}
 */
async function topLeaveApproverFor(profile) {
  const chain = await buildLeaveChain(profile);
  const top = chain.length ? chain[chain.length - 1] : null;
  if (top?.approver) return { approver: top.approver, approverName: top.approverName };

  const fallbackId = profile.hrPartner
    || (await User.findOne({ role: 'SuperAdmin', isActive: true }).sort({ createdAt: 1 }).select('_id'))?._id;
  if (!fallbackId) return null;
  const u = await User.findById(fallbackId).select('firstName lastName isActive');
  if (!u || u.isActive === false) return null;
  return {
    approver: u._id,
    approverName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
  };
}

/**
 * Give one day of an approved leave back to the employee because they worked it.
 *
 * `totalDays` is left alone — it records the span that was applied for and
 * approved. What changes is what the day COSTS: the key joins `workedDays`, so
 * it never returns to the calendar as leave, and its day comes off the split.
 * The employee's monthly paid-leave quota frees up on its own, because that is
 * counted from OnLeave attendance rows and the caller flips this day to Present.
 * Maternity leave additionally draws a banked bucket, so that day is credited
 * back to it here.
 *
 * The split is adjusted by DECREMENTING the bucket the day was actually stamped
 * into, not by recomputing it. A recompute would be wrong: the quota counter
 * reads stamped OnLeave rows, and by now this very request has stamped its own —
 * so it would see the month as full and quietly push the leave's remaining days
 * into LOP.
 *
 * @param {Object} request - the LeaveRequest document to amend
 * @param {string} dayKey - IST day key 'YYYY-MM-DD'
 * @param {boolean} [wasPaid=true] - whether the day was stamped OnLeave (paid) rather than Absent (LOP)
 * @returns {Promise<boolean>} true if the day was released, false if it already had been
 */
async function releaseLeaveDay(request, dayKey, wasPaid = true) {
  if (!request || !dayKey) return false;
  const worked = (request.workedDays || []).map(String);
  if (worked.includes(dayKey)) return false; // already given back — never twice
  request.workedDays = [...worked, dayKey];

  const weight = request.isHalfDay ? 0.5 : 1;
  if (wasPaid) request.paidDays = Math.max(0, (request.paidDays || 0) - weight);
  else request.lopDays = Math.max(0, (request.lopDays || 0) - weight);
  await request.save();

  // Maternity leave is the only type drawn from a balance bucket; hand the day back.
  if (balanceBucketFor(request.leaveType)) {
    try {
      const year = new Date(request.startDate).getFullYear();
      const balance = await getOrCreateBalance(request.employee, year);
      adjustBalance(balance, request.leaveType, -weight); // negative delta restores
      await balance.save();
    } catch (err) {
      console.error('releaseLeaveDay balance restore failed:', err.message);
    }
  }
  return true;
}

// Hierarchy step decision — the normal path. The acting user MUST be the current
// approver. Approve → advance to the next rung, or (if last) finalize + deduct
// balance. Reject → stop the chain, rejection stays visible to rungs above.
// Mutates + saves the request; throws Error with `.status` on a bad transition.
async function advanceApproval(request, userId, action, note) {
  if (request.status !== 'Pending') {
    const err = new Error(`Cannot ${action} - this request is ${request.status}.`);
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
    await notifyHrInformational(request, 'rejected', userId);
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
    // The employee hears about every rung, not just the final outcome.
    await notifyEmployeeStep(request, step, next, note);
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
  await stampLeaveAttendance(request);
  await notifyEmployeeDecision(request, note);
  await notifyHrFinalApproval(request, userId);
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
  // Capture whose turn it was (or would have been) before voiding those rungs —
  // they are told below that HR decided over them.
  const overridden = (request.approvalChain || []).filter(
    (s) => s.status === 'Pending' || s.status === 'Waiting'
  );
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
  if (action === 'approve') await stampLeaveAttendance(request);
  await notifyEmployeeDecision(request, note);
  await notifyChainVoided(request, overridden, `${action === 'approve' ? 'approved' : 'rejected'} by HR override`);
  // An override approval is still a final approval, so the SuperAdmin-named HR
  // recipients get the detailed notice — then they are excluded from the generic
  // one below rather than hearing about the same event twice.
  const toldInDetail =
    action === 'approve' ? await notifyHrFinalApproval(request, userId, { configuredOnly: true }) : [];
  await notifyHrInformational(
    request,
    `${action === 'approve' ? 'approved' : 'rejected'} (HR override)`,
    userId,
    toldInDetail
  );
  return request;
}

/**
 * HR override approve — force-approve a Pending request regardless of chain position.
 * @route PATCH /api/leave/requests/:id/approve  (HR/SuperAdmin)
 * @param {string} req.params.id - request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}; 400 on bad transition or insufficient balance
 */
// PATCH /api/leave/requests/:id/approve
const approveRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  const apProfile = await EmployeeProfile.findById(request.employee).select('hrPartner company');
  if (cannotManageProfile(req, apProfile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  try {
    await applyLeaveDecision(request, req.user._id, 'approve', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

/**
 * HR override reject — force-reject a Pending request regardless of chain position.
 * @route PATCH /api/leave/requests/:id/reject  (HR/SuperAdmin)
 * @param {string} req.params.id - request id
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 */
// PATCH /api/leave/requests/:id/reject
const rejectRequest = asyncHandler(async (req, res) => {
  const request = await LeaveRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Leave request not found');
  }
  const rjProfile = await EmployeeProfile.findById(request.employee).select('hrPartner company');
  if (cannotManageProfile(req, rjProfile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  try {
    await applyLeaveDecision(request, req.user._id, 'reject', req.body.note);
  } catch (err) {
    res.status(err.status || 400);
    throw err;
  }
  res.json({ request });
});

/**
 * List all employees' leave balances for a year (admin).
 * @route GET /api/leave/balances?year=
 * @param {number} [req.query.year] - defaults to current year
 * @returns {{year, count, balances: Object[]}} with populated employee
 */
// GET /api/leave/balances?year= — list balances (admin)
const listBalances = asyncHandler(async (req, res) => {
  const year = Number(req.query.year) || currentYear();
  const filter = await scopeEmployeeFilter(req, { year });
  const balances = await LeaveBalance.find(filter).populate({
    path: 'employee',
    select: 'employeeCode user',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  res.json({ year, count: balances.length, balances });
});

/**
 * Upsert an employee's leave-balance grants for a year; recomputes each bucket's
 * balance as opening + granted - used - encashed.
 * @route PUT /api/leave/balances/:employeeId/:year
 * @param {string} req.params.employeeId - EmployeeProfile id
 * @param {string} req.params.year
 * @param {Object} [req.body.balances] - per-type grant fields to merge
 * @returns {{balance: Object}}
 */
// PUT /api/leave/balances/:employeeId/:year — upsert grant for an employee/year
const upsertBalance = asyncHandler(async (req, res) => {
  const { employeeId, year } = req.params;
  const profile = await EmployeeProfile.findById(employeeId);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
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
  previewLeave,
  cancelMyRequest,
  setDoubleCut,
  listAllRequests,
  approveRequest,
  rejectRequest,
  listBalances,
  upsertBalance,
  applyLeaveDecision,
  advanceApproval,
  buildApprovalChain,
  ensureApprovalChain,
  // Working through your own leave — used by the attendance punch + approval path.
  leaveCoveringDay,
  topLeaveApproverFor,
  releaseLeaveDay,
  leaveLabel,
};
