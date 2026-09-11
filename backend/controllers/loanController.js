/**
 * Loan controller — employee loan/advance requests and HR administration.
 * Employees request loans (start Pending); HR lists/creates (pre-Approved),
 * reviews status, and records repayments that draw down the balance.
 */
const asyncHandler = require('express-async-handler');
const Loan = require('../models/Loan');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const khataSync = require('../services/khataSync');
const { scopeUserField, cannotSeeUser } = require('../utils/employeeScope');
const { pickableUserFilter } = require('../utils/peoplePicker');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');
const { istParts } = require('../utils/istDate');

// The longest repayment an employee may propose. A cap rather than a policy
// argument: without one, a 60,000 advance can be spread over 500 months at 120
// a month, which is not a repayment plan.
const MAX_TENURE_MONTHS = 60;

/**
 * The monthly instalment for a plan — rounded to whole rupees.
 *
 * The remainder rides on the LAST month rather than being spread: every
 * instalment is then a round, predictable number, and the balance still lands
 * exactly on zero because payroll recovers `min(emi, balance)`.
 * @param {number} principal
 * @param {number} months
 * @returns {number}
 */
const emiFor = (principal, months) => (months > 0 ? Math.round(Number(principal) / months) : 0);

// Populated employee sub-fields returned for loan references
const USER_FIELDS = 'firstName lastName email';

// ===== Telling people =====
// A loan is a conversation between an employee and whoever decides it, and
// both halves of it used to be silent: a request sat in a queue nobody was
// told about, and a decision reached the employee only if they went looking.
// Every call below is best-effort (.catch swallows it) — the money decision
// has already been saved, and a push that fails must not undo it.

// Where each audience should land. The clients rewrite the first one per
// portal (a standalone `loansAccess` holder has no admin portal — see
// resolveLink in components/Layout.jsx and ADMIN_PATH_SCREENS in the app).
const DECIDER_LINK = '/admin/loans';
const BORROWER_LINK = '/employee/loans';

const rupees = (n) => `\u20b9${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const personName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * Tell whoever decides loans that something is waiting on them.
 *
 * Asked as a CAPABILITY, not a role: `loans.manage` is held by HR, by a
 * granted Manager and by anyone a SuperAdmin ticked `loansAccess` for — the
 * accounts clerk who actually sanctions advances. Walled to the requester's
 * own company, and never sent back to the person who caused it.
 * @param {import('express').Request} req
 * @param {{title: string, body: string}} message
 */
async function notifyDeciders(req, { title, body }) {
  const recipients = (await scopeRecipientsToCompany(
    await usersHoldingAny('loans.manage'),
    req.user.scopeCompanyId,
  )).filter((id) => String(id) !== String(req.user._id));
  if (!recipients.length) return;
  // audience 'all': a decider may hold the module through a standalone grant
  // and live entirely in My Portal, where an 'admin' notification never shows.
  await notifyMany(recipients, { type: 'loan', audience: 'all', title, body, link: DECIDER_LINK });
}

/**
 * Tell the borrower what happened to their loan.
 * @param {Object} loan
 * @param {{title: string, body: string}} message
 * @param {Object} [actor] - who did it, so the notification can be replied to
 */
async function notifyBorrower(loan, { title, body }, actor) {
  if (!loan?.employee) return;
  await notify({
    recipient: loan.employee,
    sender: actor?._id,
    type: 'loan',
    audience: 'all',
    title,
    body,
    link: BORROWER_LINK,
  });
}

// ===== Employee self-service =====
/**
 * List the current user's own loans, newest first.
 * @route GET /api/loans/me
 * @returns {{count: number, loans: Object[]}}
 */
const listMine = asyncHandler(async (req, res) => {
  const loans = await Loan.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

/**
 * Employee submits a loan request (created with status Pending, balance=principal).
 *
 * The employee proposes the REPAYMENT PLAN as well as the amount: over how many
 * months, and from which salary month the deduction should start. Those two
 * answers are the difference between "lend me 30,000" and a plan somebody can
 * actually agree to, and the employee is the one who knows when their next
 * month can carry it. The EMI is derived rather than typed — principal ÷
 * tenure, rounded, with the last month absorbing the remainder — so the number
 * on screen is the number payroll will take. HR can still change any of it when
 * approving (see reviewLoan); nothing here is binding until then.
 * @route POST /api/loans/me
 * @param {string} [req.body.type]
 * @param {number} req.body.principal - required, > 0
 * @param {number} req.body.tenureMonths - required, 1-60
 * @param {number} req.body.recoveryStartYear - required, the salary year to start in
 * @param {number} req.body.recoveryStartMonth - required, 1-12
 * @param {string} req.body.reason - required
 * @returns {{loan: Object}} the created loan (201)
 */
const requestLoan = asyncHandler(async (req, res) => {
  const { type, principal, reason, tenureMonths, recoveryStartYear, recoveryStartMonth } = req.body;
  if (!(Number(principal) > 0)) {
    res.status(400);
    throw new Error('principal must be greater than 0');
  }
  if (!reason || !reason.trim()) {
    res.status(400);
    throw new Error('reason is required');
  }
  const tenure = Math.round(Number(tenureMonths));
  if (!(tenure >= 1 && tenure <= MAX_TENURE_MONTHS)) {
    res.status(400);
    throw new Error(`Choose how many months to repay over, between 1 and ${MAX_TENURE_MONTHS}.`);
  }
  const startYear = Math.round(Number(recoveryStartYear));
  const startMonth = Math.round(Number(recoveryStartMonth));
  if (!(startMonth >= 1 && startMonth <= 12) || !(startYear >= 2000 && startYear <= 2100)) {
    res.status(400);
    throw new Error('Choose the salary month the deduction should start from.');
  }
  // Refuse a start that is already in the past: payroll for a month that has
  // been run cannot go back and take an instalment, so the plan would silently
  // begin late and end late.
  const { y: nowY, m: nowM } = istParts(new Date());
  if (startYear * 12 + startMonth < nowY * 12 + nowM) {
    res.status(400);
    throw new Error('That salary month has already passed — pick this month or a later one.');
  }

  const loan = await Loan.create({
    employee: req.user._id,
    type: type || undefined,
    principal,
    balance: principal,
    reason,
    tenureMonths: tenure,
    emi: emiFor(principal, tenure),
    recoveryStartYear: startYear,
    recoveryStartMonth: startMonth,
    status: 'Pending',
  });

  notifyDeciders(req, {
    title: 'New loan request',
    body: `${personName(req.user) || 'An employee'} asked for ${rupees(loan.principal)}`
      + ` (${loan.type || 'advance'}) over ${loan.tenureMonths} month${loan.tenureMonths === 1 ? '' : 's'}`
      + ` at ${rupees(loan.emi)} a month.`,
  }).catch(() => {});

  res.status(201).json({ loan });
});

// ===== HR/Admin =====
/**
 * List all loans, optionally filtered by status, newest first.
 * @route GET /api/loans   (HR/Admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, loans: Object[]}} loans with populated employee
 */
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  // Company wall: only loans of employees this admin may see (Loan.employee is
  // a User id). No-op for SuperAdmin / unrestricted execs.
  await scopeUserField(req, filter);
  const loans = await Loan.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

/**
 * The people a loan can be raised for.
 *
 * Its own endpoint rather than /admin/users, which is gated on role
 * (SuperAdmin/HR/CEO/MD/L&D). Loans are grantable to ANY account through
 * User.loansAccess — the person who sanctions an advance is as often the
 * accounts clerk as HR — and that person would otherwise reach the queue and
 * be refused the list of people they are deciding for. Gated by the same
 * `loans.manage` capability as the rest of the module, walled to the caller's
 * own company, and shaped like a /admin/users row so the pickers (which apply
 * the portal-wide "a leaver is in no picker" rule) need no special case.
 * @route GET /api/loans/employee-options   (loans.manage)
 * @returns {{count: number, users: Object[]}}
 */
const employeeOptions = asyncHandler(async (req, res) => {
  // Active, no system logins, no executives unless opted in, own company only.
  const users = await User.find(await pickableUserFilter(req))
    .select('firstName lastName email isActive')
    .sort({ firstName: 1 })
    .lean();

  // `departed` is what the pickers read to keep somebody serving out a notice
  // period off the list — `isActive` alone still calls them a colleague on the
  // day after they walked out (see utils/peopleOptions on the clients).
  const exits = await EmployeeProfile.find({ user: { $in: users.map((u) => u._id) }, dateOfExit: { $ne: null } })
    .select('user dateOfExit')
    .lean();
  const exitBy = new Map(exits.map((p) => [String(p.user), p.dateOfExit]));

  res.json({
    count: users.length,
    users: users.map((u) => ({ ...u, dateOfExit: exitBy.get(String(u._id)) || null })),
  });
});

/**
 * HR creates a loan directly for an employee (created pre-Approved).
 * @route POST /api/loans   (HR/Admin)
 * @param {string} req.body.employee - required employee id
 * @param {number} req.body.principal - required, > 0
 * @param {string} [req.body.type]
 * @param {number} [req.body.emi]
 * @param {number} [req.body.tenureMonths]
 * @param {string} [req.body.reason]
 * @returns {{loan: Object}} the created loan (201), reviewedBy=current user
 */
const createForEmployee = asyncHandler(async (req, res) => {
  const { employee, type, principal, emi, tenureMonths, reason } = req.body;
  if (!employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  if (!(Number(principal) > 0)) {
    res.status(400);
    throw new Error('principal must be greater than 0');
  }
  // Company wall: an admin cannot open a loan for another company's employee.
  if (await cannotSeeUser(req, employee)) {
    res.status(404);
    throw new Error('Employee not found');
  }
  const loan = await Loan.create({
    employee,
    type: type || undefined,
    principal,
    emi: emi || 0,
    tenureMonths: tenureMonths || 0,
    balance: principal,
    reason,
    status: 'Approved',
    reviewedBy: req.user._id,
  });

  // Nobody asked for this one — the employee is hearing about it for the
  // first time, so the message says what it is rather than "approved".
  notifyBorrower(loan, {
    title: 'A loan has been set up for you',
    body: `${loan.type || 'A loan'} of ${rupees(loan.principal)}`
      + `${loan.emi ? `, recovered at ${rupees(loan.emi)} a month` : ''}.`,
  }, req.user).catch(() => {});

  res.status(201).json({ loan });
});

/**
 * HR reviews/updates a loan: change status and, when approving/activating, set
 * EMI, tenure and disbursement details.
 * @route PATCH /api/loans/:id/review   (HR/Admin)
 * @param {string} req.params.id - loan id
 * @param {string} [req.body.status]
 * @param {string} [req.body.reviewNote]
 * @param {number} [req.body.emi] - applied only when Approved/Active
 * @param {number} [req.body.tenureMonths] - applied only when Approved/Active
 * @param {string} [req.body.disbursedOn] - applied only when Approved/Active
 * @returns {{loan: Object}} the updated loan
 */
const reviewLoan = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  // Company wall: a loan of an employee this admin may not see is reported as
  // not found — its existence is none of their business.
  if (!loan || (await cannotSeeUser(req, loan.employee))) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const {
    status, reviewNote, emi, tenureMonths, disbursedOn,
    recoveryStartYear, recoveryStartMonth,
  } = req.body;
  // Remembered before the overwrite so the khata is posted only on the FIRST
  // activation, not every time an already-active loan is edited — and so the
  // employee is told about a real DECISION rather than about somebody fixing
  // an EMI on a loan whose status never moved.
  const wasActive = loan.status === 'Active';
  const prevStatus = loan.status;
  if (status) loan.status = status;
  if (reviewNote !== undefined) loan.reviewNote = reviewNote;

  // EMI/tenure/disbursement only meaningful once approved or active
  if (status === 'Approved' || status === 'Active') {
    if (emi !== undefined) loan.emi = emi;
    if (tenureMonths !== undefined) loan.tenureMonths = tenureMonths;
    // HR can move the start month the employee asked for, e.g. because the
    // sanction came through after that month's payroll had already run.
    if (recoveryStartYear !== undefined) loan.recoveryStartYear = Math.round(Number(recoveryStartYear)) || 0;
    if (recoveryStartMonth !== undefined) loan.recoveryStartMonth = Math.round(Number(recoveryStartMonth)) || 0;
    if (disbursedOn !== undefined) loan.disbursedOn = disbursedOn;
  }
  // Activating a fresh loan seeds the outstanding balance from the principal
  if (status === 'Active' && loan.balance === 0) {
    loan.balance = loan.principal;
  }
  loan.reviewedBy = req.user._id;
  const becameActive = status === 'Active' && !wasActive;
  await loan.save();

  // Mirror the disbursement into the borrower's khata, so one screen shows the
  // whole money position with this person rather than loans and cash advances
  // sitting in two places. Idempotent and best-effort: it never blocks the
  // approval it is following. Pass `cashAccount` to bank the payout as well.
  if (becameActive) {
    await khataSync.syncLoanDisbursement(loan, req.user, { cashAccount: req.body.cashAccount });
  }

  // Only a STATUS change is news. Correcting an EMI or a start month on an
  // already-approved loan is housekeeping, and a push for it would teach
  // people to ignore the ones that matter.
  if (status && status !== prevStatus) {
    const amount = rupees(loan.principal);
    const plan = loan.emi ? ` ${rupees(loan.emi)} a month will be recovered from your salary.` : '';
    const message = {
      Approved: {
        title: 'Your loan request was approved',
        body: `${loan.type || 'Loan'} of ${amount} approved.${plan}`,
      },
      Rejected: {
        title: 'Your loan request was declined',
        body: loan.reviewNote ? `${amount}: ${loan.reviewNote}` : `${loan.type || 'Loan'} of ${amount} was not approved.`,
      },
      Active: {
        title: 'Your loan has been disbursed',
        body: `${amount} released.${plan}`,
      },
      Closed: {
        title: 'Your loan is fully repaid',
        body: `Nothing is outstanding on your ${(loan.type || 'loan').toLowerCase()} of ${amount}.`,
      },
    }[loan.status];
    if (message) notifyBorrower(loan, message, req.user).catch(() => {});
  }

  res.json({ loan });
});

/**
 * Record a repayment against a loan, reducing its balance; auto-closes at zero.
 * @route POST /api/loans/:id/repayment   (HR/Admin)
 * @param {string} req.params.id - loan id
 * @param {number} req.body.amount - required, > 0
 * @returns {{loan: Object}} the updated loan (status Closed when balance hits 0)
 */
const recordRepayment = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  // Company wall: same not-found treatment as reviewLoan.
  if (!loan || (await cannotSeeUser(req, loan.employee))) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const amount = Number(req.body.amount);
  if (!(amount > 0)) {
    res.status(400);
    throw new Error('amount must be greater than 0');
  }
  // Draw down balance (never below zero) and close the loan when fully repaid
  loan.balance = Math.max(0, loan.balance - amount);
  if (loan.balance === 0) loan.status = 'Closed';
  await loan.save();

  // Mirror the repayment into the khata so the employee's balance follows the
  // loan down. Best-effort; a failure here never voids a recorded repayment.
  await khataSync.syncLoanRepayment(loan, amount, req.user, { cashAccount: req.body.cashAccount });

  // What is LEFT is the part people actually want to know.
  notifyBorrower(loan, {
    title: loan.balance === 0 ? 'Your loan is fully repaid' : 'Repayment recorded',
    body: loan.balance === 0
      ? `${rupees(amount)} recorded. Nothing is outstanding.`
      : `${rupees(amount)} recorded. ${rupees(loan.balance)} still outstanding.`,
  }, req.user).catch(() => {});

  res.json({ loan });
});

module.exports = {
  listMine, requestLoan, listAll, employeeOptions, createForEmployee, reviewLoan, recordRepayment,
};
