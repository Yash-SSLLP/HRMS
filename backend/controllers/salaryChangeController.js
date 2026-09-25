/**
 * Salary-change controller — the queue of salary changes an HR proposed and a
 * CEO, MD or Super Admin has to approve, and the decision on each. The rule
 * itself, and everything that raises a request, lives in
 * services/salaryChanges.js; this is only the queue.
 *
 * Mounted on the payroll router ABOVE its `payroll.manage` gate (see
 * routes/payrollRoutes.js): a read-only CEO/MD holds no capability and is still
 * the person these requests are addressed to.
 */
const asyncHandler = require('express-async-handler');
const SalaryChangeRequest = require('../models/SalaryChangeRequest');
const { SALARY_CHANGE_STATUSES, SALARY_CHANGE_KINDS } = require('../models/SalaryChangeRequest');
const EmployeeProfile = require('../models/EmployeeProfile');
const SalaryStructure = require('../models/SalaryStructure');
const { allowedEmployeeIds, cannotManageProfile } = require('../utils/employeeScope');
const { canApproveSalaryChanges } = require('../middleware/authMiddleware');
const svc = require('../services/salaryChanges');

/**
 * The requests this viewer may see: every structure change (a template belongs
 * to no company), and the salary changes of the employees inside their company
 * wall — the same wall every payroll list applies.
 * @param {import('express').Request} req
 * @param {Object} [base] - filter to narrow further
 * @returns {Promise<Object>}
 */
async function visibleFilter(req, base = {}) {
  const ids = await allowedEmployeeIds(req); // null = unrestricted
  if (!ids) return base;
  return { ...base, $or: [{ kind: 'structure' }, { employee: { $in: ids } }] };
}

/**
 * How many salary changes are waiting on THIS account — the Approvals pill and
 * the Salary Revisions badge. Zero for anyone who cannot decide one: an HR's own
 * requests are waiting on somebody else, and a badge they cannot clear is one
 * they learn to ignore.
 * @param {import('express').Request} req
 * @returns {Promise<number>}
 */
async function countPendingSalaryChanges(req) {
  if (!canApproveSalaryChanges(req.user)) return 0;
  return SalaryChangeRequest.countDocuments(await visibleFilter(req, { status: 'Pending' }));
}

/**
 * List salary changes.
 * @route GET /api/payroll/salary-changes  (payroll.manage; CEO/MD/God read)
 * @param {string} [req.query.status] - Pending (default) | Approved | Rejected | Withdrawn | all |
 *   decided (every one that is no longer Pending — the Approvals page's History)
 * @param {string} [req.query.kind] - setup | revision | structure
 * @param {string} [req.query.employee] - EmployeeProfile id
 * @param {string} [req.query.structure] - SalaryStructure id
 * @returns {{count: number, canApprove: boolean, requests: Object[]}} each with
 *   `summary`, `canDecide` and `canWithdraw` for this viewer
 */
const listSalaryChanges = asyncHandler(async (req, res) => {
  const status = req.query.status || 'Pending';
  if (status !== 'all' && status !== 'decided' && !SALARY_CHANGE_STATUSES.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${SALARY_CHANGE_STATUSES.join(', ')}, decided or all`);
  }
  const base = {};
  // 'decided' is asked for server-side rather than filtered out of 'all' on the
  // client: the 200-row cap below would otherwise count waiting rows against it.
  if (status === 'decided') base.status = { $ne: 'Pending' };
  else if (status !== 'all') base.status = status;
  if (req.query.kind) {
    if (!SALARY_CHANGE_KINDS.includes(req.query.kind)) {
      res.status(400);
      throw new Error(`kind must be one of ${SALARY_CHANGE_KINDS.join(', ')}`);
    }
    base.kind = req.query.kind;
  }
  if (req.query.employee) base.employee = req.query.employee;
  if (req.query.structure) base.structure = req.query.structure;

  const rows = await svc.populated(SalaryChangeRequest.find(await visibleFilter(req, base)))
    .sort({ createdAt: -1 })
    // The waiting queue is short by nature; history is capped rather than paged.
    .limit(status === 'Pending' ? 500 : 200)
    .lean();
  res.json({
    count: rows.length,
    canApprove: canApproveSalaryChanges(req.user),
    requests: rows.map((r) => svc.shapeForViewer(req, r)),
  });
});

/** A request as the response carries it, reloaded after a write. */
async function reshaped(req, id) {
  const full = await svc.populated(SalaryChangeRequest.findById(id)).lean();
  return svc.shapeForViewer(req, full);
}

/**
 * Approve (apply it) or turn down a salary change.
 *
 * The decision is CLAIMED atomically — Pending → decided in one conditional
 * update — before anything is applied. Two approvers pressing Approve at once
 * would otherwise both apply it, and a CTC revision applied twice is two entries
 * in somebody's salary history. If applying then fails, the claim is released
 * and the request is back in the queue exactly as it was.
 *
 * @param {boolean} approve
 * @returns {import('express').RequestHandler}
 */
const decideSalaryChange = (approve) => asyncHandler(async (req, res) => {
  // The route guard says the same; this is here so the handler is safe however
  // it is mounted — deciding a salary is the whole point of the bench.
  if (!canApproveSalaryChanges(req.user)) {
    res.status(403);
    throw new Error('Only a CEO, MD or Super Admin can approve a salary change.');
  }
  const request = await SalaryChangeRequest.findById(req.params.id);
  if (!request) {
    res.status(404);
    throw new Error('Salary change not found');
  }
  if (request.status !== 'Pending') {
    res.status(409);
    throw new Error(`This change has already been ${request.status.toLowerCase()}.`);
  }

  let profile = null;
  let structure = null;
  if (request.kind === 'structure') {
    structure = await SalaryStructure.findById(request.structure);
  } else {
    profile = await EmployeeProfile.findById(request.employee);
    // The company wall and "nobody decides their own salary", as on every other
    // per-employee payroll route. A deleted employee falls through: the request
    // can still be turned down, and approving it is refused as stale.
    if (profile && cannotManageProfile(req, profile)) {
      res.status(403);
      throw new Error('This employee is outside the companies you cover, or this is your own salary — another approver has to decide it.');
    }
  }
  if (String(request.requestedBy) === String(req.user._id)) {
    res.status(403);
    throw new Error('You asked for this change, so another approver has to decide it.');
  }

  const note = String(req.body?.note || '').trim().slice(0, 500);
  if (!approve && !note) {
    res.status(400);
    throw new Error('Say why it is being turned down — the note is all HR is shown.');
  }

  // Refuse a stale approval BEFORE claiming, so the common failure leaves the
  // request untouched rather than decided-and-reverted in the audit trail.
  if (approve) await svc.assertNotStale(request, profile, structure);

  const decision = {
    status: approve ? 'Approved' : 'Rejected',
    decidedBy: req.user._id,
    decidedByName: svc.actorName(req.user),
    decidedAt: new Date(),
    decisionNote: note || undefined,
  };
  const claimed = await SalaryChangeRequest.findOneAndUpdate(
    { _id: request._id, status: 'Pending' },
    { $set: decision },
    { new: true }
  );
  if (!claimed) {
    res.status(409);
    throw new Error('Somebody else decided this change a moment ago — refresh to see what they did.');
  }

  if (approve) {
    try {
      await svc.applyApproved(claimed, req.user, { profile, structure });
      if (claimed.isModified()) await claimed.save(); // appliedLive, on a revision
    } catch (err) {
      await SalaryChangeRequest.updateOne(
        { _id: claimed._id },
        { $set: { status: 'Pending' }, $unset: { decidedBy: 1, decidedByName: 1, decidedAt: 1, decisionNote: 1 } }
      );
      throw err;
    }
  }

  svc.notifyRequester(claimed, req.user);
  res.json({ request: await reshaped(req, claimed._id) });
});

/** @route PATCH /api/payroll/salary-changes/:id/approve  (CEO/MD/SuperAdmin) */
const approveSalaryChange = decideSalaryChange(true);
/** @route PATCH /api/payroll/salary-changes/:id/reject  (CEO/MD/SuperAdmin; `note` required) */
const rejectSalaryChange = decideSalaryChange(false);

/**
 * Take back one's own request while it is still waiting.
 * @route PATCH /api/payroll/salary-changes/:id/withdraw  (the requester)
 * @returns {{request: Object}}
 */
const withdrawSalaryChange = asyncHandler(async (req, res) => {
  const request = await SalaryChangeRequest.findById(req.params.id).select('requestedBy status');
  if (!request) {
    res.status(404);
    throw new Error('Salary change not found');
  }
  if (String(request.requestedBy) !== String(req.user._id)) {
    res.status(403);
    throw new Error('Only whoever asked for this change can withdraw it.');
  }
  const claimed = await SalaryChangeRequest.findOneAndUpdate(
    { _id: request._id, status: 'Pending' },
    { $set: { status: 'Withdrawn', decidedBy: req.user._id, decidedByName: svc.actorName(req.user), decidedAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    res.status(409);
    throw new Error('This change has already been decided, so it can no longer be withdrawn.');
  }
  res.json({ request: await reshaped(req, claimed._id) });
});

module.exports = {
  listSalaryChanges,
  approveSalaryChange,
  rejectSalaryChange,
  withdrawSalaryChange,
  countPendingSalaryChanges,
};
