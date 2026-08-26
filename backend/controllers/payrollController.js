/**
 * Payroll controller — payslips (Payroll) and the monthly payroll run. Employees
 * view/download their own Approved/Paid payslips and an attendance-policy summary.
 * HR list/export payslips, run payroll org-wide (Draft seeded from the last slip)
 * or per-employee (salary structure % × CTC), then edit / approve / mark Paid,
 * render the salary-slip PDF, and share/email via a public no-login link.
 * Status flow: Draft → Approved → Paid.
 *
 * Attendance never reduces an earning: Basic and every other component are paid
 * at their full monthly value, and days not worked are recovered on the
 * deductions side as `lopDeduction`, alongside the 2-paid-leaves/month policy,
 * the late-arrival penalty and active loan / salary-advance EMIs.
 */
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Payroll = require('../models/Payroll');
const EmployeeProfile = require('../models/EmployeeProfile');
const { employeeProfileScope, scopeEmployeeFilter, cannotManageProfile } = require('../utils/employeeScope');
const Attendance = require('../models/Attendance');
const Loan = require('../models/Loan');
const Holiday = require('../models/Holiday');
const { LeaveRequest, EMERGENCY_LEAVE } = require('../models/Leave');
const { monthRangeIST, ymdIST } = require('../utils/dateHelpers');
const { daysOnPayroll, prorateAllowance } = require('../utils/monthlyQuota');
const { lateMinutes, getLatePolicy } = require('../utils/workday');
const { compOffKeysFor, isRestDayRecord, approvedDoublePayDays, doublePayState } = require('../utils/restDay');
const { renderPayslip } = require('../services/payslipPdf');
const { buildPayslipLines } = require('../services/payslipLines');
const { buildPayslipFields, buildClassicRows, MONTHS: MONTHS_LONG } = require('../services/payslipFields');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');
const { buildYtd, computeYtdFrom } = require('../services/payslipYtd');
const { enqueueMail } = require('../services/email');
const ExcelJS = require('exceljs');
// exportPayrollSheet builds the company payroll register (.xlsx) via ExcelJS — see below.

// Money as the payslip prints it, so all three surfaces show the same string.
const inrOrDash = (n) => (Math.round(Number(n) || 0) === 0
  ? '—'
  : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n))}`);

// Serialize a payslip with its printable breakdown attached, so the web and
// mobile screens render the same components the PDF does instead of each
// keeping its own list of labels. See services/payslipLines.js. `ytd` is
// optional — the admin list omits it, since a table of totals has no use for
// per-employee cumulative figures and it would cost a query per row.
//
// `details` is the identity/statutory/bank block, in the same order and wording
// the PDF prints (services/payslipFields.js). It is built only for an employee
// reading their OWN slip — it carries their PAN, Aadhaar and bank account, so it
// has no business in a list of everyone's payslips.
const withLines = (payslip, ytd, { details = false } = {}) => {
  const out = {
    ...payslip.toJSON(),
    lines: buildPayslipLines(payslip, ytd),
    ytd: ytd || null,
  };
  if (details) {
    out.details = buildClassicRows(buildPayslipFields(payslip, inrOrDash));
    // The profile was populated only to build those rows; the payload keeps the
    // plain id it has always carried rather than shipping the whole profile.
    out.employee = payslip.employee?._id || payslip.employee;
  }
  return out;
};

// The employee's own slip needs the full profile to build `details`. Aadhaar is
// select:false, so it is asked for explicitly — this is the person's own record.
const MY_PAYSLIP_POPULATE = {
  path: 'employee',
  select: '+aadhaar',
  populate: { path: 'user', select: 'firstName lastName' },
};

// ===== Release workflow =====
// A payslip belongs to HR until they hand it over. The employee asks for it, HR
// approves, corrects and previews, and only on finalising can the employee
// download. See the `release` sub-doc in models/Payroll.js for the states.

// Only a finalised payslip may leave HR's hands.
const isReleased = (payslip) => payslip?.release?.status === 'Finalised';

// Append to the trail every transition writes, so a disputed slip can be read
// back in order rather than inferred from timestamps.
function logRelease(payslip, action, actor, note) {
  if (!payslip.release) payslip.release = {};
  if (!Array.isArray(payslip.release.history)) payslip.release.history = [];
  payslip.release.history.push({
    action,
    at: new Date(),
    by: actor?._id,
    byName: actor?.fullName || `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim() || undefined,
    note: note || undefined,
  });
}

const periodLabel = (p) => `${MONTHS_LONG[(p.payPeriodMonth || 1) - 1]} ${p.payPeriodYear}`;

// Tell the people who run payroll that something is waiting on them — only the
// ones covering the employee's company (the wall the read paths enforce).
async function notifyPayrollTeam(title, body, companyId) {
  try {
    await notifyMany(await scopeRecipientsToCompany(await usersHoldingAny('payroll.manage'), companyId), {
      type: 'payroll',
      audience: 'admin',
      title,
      body,
      link: '/admin/payroll',
    });
  } catch (err) {
    console.error('payslip release notify failed:', err.message);
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

/**
 * List the caller's own Approved/Paid payslips, newest first.
 * @route GET /api/payroll/me  (employee)
 * @returns {{count: number, payslips: Object[]}}
 */
// GET /api/payroll/me  (employee)
const listMyPayslips = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const payslips = await Payroll.find({
    employee: profile._id,
    status: { $in: ['Approved', 'Paid'] },
  }).populate(MY_PAYSLIP_POPULATE).sort({ payPeriodYear: -1, payPeriodMonth: -1 });
  // Every slip this employee has is already in hand, so each one's year-to-date
  // is accumulated in memory rather than costing a query per row.
  res.json({
    count: payslips.length,
    payslips: payslips.map((p) => withLines(p, computeYtdFrom(payslips, p), { details: true })),
  });
});

/**
 * Get the caller's own payslip for a period (Approved/Paid only).
 * @route GET /api/payroll/me/:year/:month  (employee)
 * @param {string} req.params.year / req.params.month
 * @returns {{payslip: Object}}
 */
// GET /api/payroll/me/:year/:month  (employee)
const getMyPayslip = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const payslip = await Payroll.findOne({
    employee: profile._id,
    payPeriodYear: Number(req.params.year),
    payPeriodMonth: Number(req.params.month),
    status: { $in: ['Approved', 'Paid'] },
  }).populate(MY_PAYSLIP_POPULATE);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  res.json({ payslip: withLines(payslip, await buildYtd(payslip), { details: true }) });
});

// Fetch one of the caller's own finalised-or-not payslips, or 404.
async function myPayslipOrFail(req, res) {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const payslip = await Payroll.findOne({
    _id: req.params.id,
    employee: profile._id,
    status: { $in: ['Approved', 'Paid'] },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  return payslip;
}

/**
 * Ask HR to release this month's payslip.
 * @route POST /api/payroll/me/:id/request  (employee)
 * @param {string} req.params.id - payslip id
 * @returns {{release: Object}}
 * @sideeffect notifies everyone holding payroll.manage
 */
const requestMyPayslip = asyncHandler(async (req, res) => {
  const payslip = await myPayslipOrFail(req, res);
  const state = payslip.release?.status || 'NotRequested';
  if (state !== 'NotRequested') {
    res.status(400);
    throw new Error(state === 'Finalised'
      ? 'This payslip has already been released — you can download it.'
      : 'You have already asked for this payslip. HR is looking at it.');
  }
  payslip.release.status = 'Requested';
  payslip.release.requestedAt = new Date();
  payslip.release.requestedBy = req.user._id;
  logRelease(payslip, 'Requested', req.user);
  await payslip.save();

  const who = req.user.fullName || `${req.user.firstName} ${req.user.lastName}`.trim();
  await notifyPayrollTeam('Payslip requested',
    `${who} asked for their ${periodLabel(payslip)} payslip.`, req.user.scopeCompanyId);
  res.json({ release: payslip.release });
});

/**
 * Ask HR to correct an already-released payslip.
 * @route POST /api/payroll/me/:id/change-request  (employee)
 * @param {string} req.params.id - payslip id
 * @param {string} req.body.note - what the employee believes is wrong (required)
 * @returns {{release: Object}}
 * @sideeffect notifies everyone holding payroll.manage
 */
const requestMyPayslipChange = asyncHandler(async (req, res) => {
  const payslip = await myPayslipOrFail(req, res);
  if (!isReleased(payslip)) {
    res.status(400);
    throw new Error('You can only ask for a correction once the payslip has been released to you.');
  }
  const note = String(req.body.note || '').trim();
  if (!note) {
    res.status(400);
    throw new Error('Please describe what needs correcting.');
  }
  payslip.release.status = 'ChangeRequested';
  payslip.release.changeNote = note;
  logRelease(payslip, 'ChangeRequested', req.user, note);
  await payslip.save();

  const who = req.user.fullName || `${req.user.firstName} ${req.user.lastName}`.trim();
  await notifyPayrollTeam('Payslip correction requested',
    `${who} asked for a change to their ${periodLabel(payslip)} payslip: ${note}`, req.user.scopeCompanyId);
  res.json({ release: payslip.release });
});

/**
 * Approve an employee's request, opening the payslip for HR to check and correct.
 * @route PATCH /api/payroll/:id/release/approve  (payroll.manage)
 * @param {string} req.params.id - payslip id
 * @returns {{payslip: Object}}
 * @sideeffect notifies the employee that HR is preparing it
 */
const approvePayslipRelease = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate('employee', 'user');
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (payslip.release?.status !== 'Requested') {
    res.status(400);
    throw new Error('Only a requested payslip can be approved for release.');
  }
  payslip.release.status = 'Approved';
  payslip.release.approvedAt = new Date();
  payslip.release.approvedBy = req.user._id;
  logRelease(payslip, 'Approved', req.user);
  await payslip.save();

  const recipient = payslip.employee?.user;
  if (recipient) {
    notify({
      recipient,
      type: 'payroll',
      audience: 'employee',
      title: 'Payslip request approved',
      body: `HR is preparing your ${periodLabel(payslip)} payslip. You'll be told when it's ready.`,
      link: '/employee/payslips',
    }).catch((err) => console.error('payslip approve notify failed:', err.message));
  }
  res.json({ payslip });
});

/**
 * Finalise a payslip — the point at which the employee may download it.
 * @route PATCH /api/payroll/:id/release/finalise  (payroll.manage)
 * @param {string} req.params.id - payslip id
 * @returns {{payslip: Object}}
 * @sideeffect notifies the employee that it is ready
 */
const finalisePayslipRelease = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate('employee', 'user');
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  const state = payslip.release?.status;
  if (!['Approved', 'ChangeRequested'].includes(state)) {
    res.status(400);
    throw new Error(state === 'Finalised'
      ? 'This payslip is already final.'
      : 'Approve the request before finalising the payslip.');
  }
  if (!['Approved', 'Paid'].includes(payslip.status)) {
    res.status(400);
    throw new Error('Approve the payslip itself before releasing it to the employee.');
  }
  payslip.release.status = 'Finalised';
  payslip.release.finalisedAt = new Date();
  payslip.release.finalisedBy = req.user._id;
  // The correction has been dealt with; clear it so the next one stands alone.
  payslip.release.changeNote = undefined;
  logRelease(payslip, 'Finalised', req.user);
  await payslip.save();

  const recipient = payslip.employee?.user;
  if (recipient) {
    notify({
      recipient,
      type: 'payroll',
      audience: 'employee',
      title: 'Payslip ready',
      body: `Your ${periodLabel(payslip)} payslip is final and ready to download.`,
      link: '/employee/payslips',
    }).catch((err) => console.error('payslip finalise notify failed:', err.message));
  }
  res.json({ payslip });
});

/**
 * The caller's month attendance-policy summary (lateness, paid-leave usage,
 * expected penalty/incentive).
 * @route GET /api/payroll/me/attendance-summary?year=&month=  (employee)
 * @param {number} [req.query.year] / [req.query.month] - default current
 * @returns {{year, month, needsSetup, policy}}
 */
// GET /api/payroll/me/attendance-summary?year=&month=  (employee)
// Self-service view of this month's lateness + paid-leave usage against policy,
// and the resulting expected late-penalty / leave-incentive — so an employee can
// see how many days they were late and what deduction to expect.
const myAttendanceSummary = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id }).populate('salaryStructure');
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  const [cy, cm] = ymdIST(new Date()).split('-').map(Number);
  const year = Number(req.query.year) || cy;
  const month = Number(req.query.month) || cm;
  const computed = await computeEmployeeRun(profile, year, month);
  res.json({ year, month, needsSetup: computed.needsSetup, policy: computed.policy });
});

// --- HR/Admin endpoints ---

/**
 * List payslips with optional filters.
 * @route GET /api/payroll  (HR/Admin)
 * @param {string} [req.query.employee] / [req.query.year] / [req.query.month] / [req.query.status]
 * @returns {{count: number, payslips: Object[]}} with populated employee
 */
// GET /api/payroll  (HR/Admin) — filters: employee, year, month, status
// Per-record scope guard for payroll: 403 unless this admin may manage the
// payslip's employee (Backend → all; HR Manager → their assigned employees; a
// company-limited exec → their companies). Call once the payslip is loaded and
// confirmed to exist.
async function guardPayslipScope(req, res, payslip) {
  const empId = payslip.employee && payslip.employee._id ? payslip.employee._id : payslip.employee;
  const profile = await EmployeeProfile.findById(empId).select('hrPartner company');
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
}

const listPayslips = asyncHandler(async (req, res) => {
  const { employee, year, month, status, releaseStatus } = req.query;
  const filter = {};
  if (employee) filter.employee = employee;
  if (year) filter.payPeriodYear = Number(year);
  if (month) filter.payPeriodMonth = Number(month);
  if (status) filter.status = status;
  // Comma-separated so the requests queue can ask for everything awaiting HR in
  // one call. 'NotRequested' has to match slips saved before the release
  // workflow existed, which carry no `release` field at all.
  if (releaseStatus) {
    const wanted = String(releaseStatus).split(',').map((s) => s.trim()).filter(Boolean);
    filter.$or = [
      { 'release.status': { $in: wanted } },
      ...(wanted.includes('NotRequested') ? [{ 'release.status': { $exists: false } }] : []),
    ];
  }

  // Limit to the employees this admin may see (also intersects a specific
  // ?employee= against their scope).
  await scopeEmployeeFilter(req, filter);

  const payslips = await Payroll.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user designation',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ payPeriodYear: -1, payPeriodMonth: -1, createdAt: -1 });
  res.json({ count: payslips.length, payslips: payslips.map(withLines) });
});

const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ===== Payroll register (.xlsx) =====
// The company's payroll sheet, one row per active employee, in the exact column
// layout HR uses to disburse salaries. This is a SIMPLER money model than the
// in-app payslip (no EPF/ESIC/loan): the full monthly salary is shown, and lost
// days are charged back as a single "ABSENT AMOUNT" deduction line.
//
//   NET DAYS         paid days out of the month — Sundays and holidays are paid,
//                    so a clean full month = every calendar day (July = 31)
//   ABSENT DAYS      unpaid days = Absent + missed-punch + leave beyond the 2/mo
//                    quota + any days before joining / after exit
//                    (NET DAYS + ABSENT DAYS = days in the month)
//   LNT + EXTRA DAYS unused paid-leave quota = max(0, 2 − leaves taken)
//   SALARY           full monthly salary = CTC ÷ 12 (independent of attendance)
//   ARREARS/BONUS    optional, from a saved payslip for the month
//   GROSS SALARY     = SALARY + ARREARS/BONUS
//   ADVANCE          this month's salary-advance EMI (Loan type 'Salary Advance')
//   Old/Weekly Advance + Interest   left blank for HR to fill in manually
//   LATE DEDUCTION   late-arrival penalty (> 5 late/mo rule) — as in the app
//   ABSENT AMOUNT    per-day salary × ABSENT DAYS  (perDay = SALARY ÷ days-in-month)
//   PT               professional tax (flat, set by HR)
//   DEDUCTIONS       = advances + LATE + Interest + ABSENT AMOUNT + PT
//   NET PAYABLE      = GROSS − DEDUCTIONS
const PAYROLL_SHEET_COLUMNS = [
  { header: 'SL.NO', key: 'sl', width: 6 },
  { header: 'NAME', key: 'name', width: 24 },
  { header: 'EMP NO', key: 'empNo', width: 10 },
  { header: 'DESIGNATION', key: 'designation', width: 16 },
  { header: 'NET DAYS', key: 'netDays', width: 9 },
  { header: 'ABSENT DAYS', key: 'absentDays', width: 11 },
  { header: 'LNT + EXTRA DAYS', key: 'lnt', width: 15 },
  { header: 'SALARY', key: 'salary', width: 12 },
  { header: 'ARREARS/BONUS', key: 'bonus', width: 14 },
  // Approved Sunday / comp-off duty, paid at one extra day per day worked.
  { header: 'DUTY PAY', key: 'dutyPay', width: 11 },
  { header: 'GROSS SALARY', key: 'gross', width: 13 },
  { header: 'Old Advance', key: 'oldAdvance', width: 12 },
  { header: 'Weekly Advance', key: 'weeklyAdvance', width: 14 },
  { header: 'ADVANCE', key: 'advance', width: 11 },
  { header: 'LATE DEDUCTION', key: 'lateDeduction', width: 14 },
  { header: 'Interest', key: 'interest', width: 10 },
  { header: 'ABSENT AMOUNT', key: 'absentAmount', width: 14 },
  { header: 'PT', key: 'pt', width: 8 },
  { header: 'DEDUCTIONS', key: 'deductions', width: 12 },
  { header: 'NET PAYABLE', key: 'netPayable', width: 13 },
];

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * Build one payroll-register row from a computed monthly run. Pure (no I/O) so
 * the column arithmetic is unit-testable. The old/weekly advance and interest
 * columns are always blank (HR fills them in), so the GROSS/DEDUCTIONS/NET
 * totals are written as live Excel formulas — the sheet re-totals itself when
 * HR types those in.
 * @param {number} sl - 1-based serial number
 * @param {{name,empNo,designation}} meta
 * @param {object} run - a computeEmployeeRun(...) result
 * @param {number} [bonus] - ARREARS/BONUS from a saved payslip, if any
 * @returns {object} keyed by PAYROLL_SHEET_COLUMNS keys (numbers, '' for blanks)
 */
function buildPayrollSheetRow(sl, meta, run, bonus = 0) {
  const daysInMonth = run.daysInMonth || 0;
  const monthlySalary = Math.round((run.ctc || 0) / 12);
  const perDay = daysInMonth ? monthlySalary / daysInMonth : 0;
  // Charge back everything not paid out of the full month — LOP plus any days
  // before joining / after exit — because SALARY below is the full monthly figure.
  const unpaidDays = round1(run.unpaidDays != null ? run.unpaidDays : (run.lopDays || 0));
  const netDays = round1(run.paidDays || 0);
  const absentAmount = Math.round(perDay * unpaidDays);
  const lateDeduction = Math.round((run.policy && run.policy.latePenalty) || run.latePenalty || 0);
  const pt = Math.round((run.statutoryDeductions && run.statutoryDeductions.professionalTax) || 0);
  const advance = Math.round(run.salaryAdvance || 0);
  // Approved Sunday / comp-off duty gets its own money column, with the day
  // count alongside the unused-leave days in "LNT + EXTRA DAYS".
  const dutyPay = Math.round((run.policy && run.policy.doubleDayPay) || run.doubleDayPay || 0);
  const dutyDays = round1((run.policy && run.policy.doublePayDays) || run.doublePayDays || 0);
  const bonusAmt = Math.round(bonus || 0);
  return {
    sl,
    name: meta.name,
    empNo: meta.empNo || '',
    designation: meta.designation || '',
    netDays,
    absentDays: unpaidDays,
    lnt: round1((run.policy ? (run.policy.unusedLeave || 0) : 0) + dutyDays),
    salary: monthlySalary,
    bonus: bonusAmt || '',      // optional — blank when there's no arrear/bonus
    dutyPay: dutyPay || '',     // blank unless a rest day was worked and approved
    gross: monthlySalary + bonusAmt + dutyPay,
    oldAdvance: '',             // ── old/weekly advance + interest filled in by HR ──
    weeklyAdvance: '',
    advance: advance || '',     // this month's salary-advance EMI
    lateDeduction,
    interest: '',
    absentAmount,
    pt,
    deductions: advance + lateDeduction + absentAmount + pt,
    netPayable: (monthlySalary + bonusAmt + dutyPay) - (advance + lateDeduction + absentAmount + pt),
  };
}

// Spreadsheet column letter for a 1-based index (1 → A, 27 → AA).
function columnLetter(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// key -> column letter, derived from PAYROLL_SHEET_COLUMNS so the formulas below
// follow the layout. They used to be written as literal letters, which silently
// pointed at the wrong columns the moment one was inserted.
const COL = Object.fromEntries(
  PAYROLL_SHEET_COLUMNS.map((c, i) => [c.key, columnLetter(i + 1)])
);
// Column groups by meaning: day counts vs money (everything from SALARY right).
const DAY_COLS = ['netDays', 'absentDays', 'lnt'].map((k) => COL[k]);
const MONEY_COLS = PAYROLL_SHEET_COLUMNS
  .slice(PAYROLL_SHEET_COLUMNS.findIndex((c) => c.key === 'salary'))
  .map((c) => COL[c.key]);

// Assemble the workbook from pre-built rows. GROSS/DEDUCTIONS/NET are set as
// formulas so the file recalculates if HR edits salary, bonus or the advances.
function buildPayrollWorkbook(rows, year, month) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();
  const ws = wb.addWorksheet(`Payroll ${MONTH_NAMES[month]} ${year}`.slice(0, 31));
  ws.columns = PAYROLL_SHEET_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  // Header styling.
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 28;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });

  const MONEY = '#,##0';
  const DAYS = '0.##';
  rows.forEach((r, i) => {
    const excelRow = ws.addRow(r);
    const n = excelRow.number; // 1-based sheet row (header is row 1)
    // Live totals so the sheet stays correct when HR fills advances/interest.
    // GROSS = SALARY + ARREARS/BONUS + DUTY PAY
    ws.getCell(`${COL.gross}${n}`).value = { formula: `${COL.salary}${n}+${COL.bonus}${n}+${COL.dutyPay}${n}` };
    // DEDUCTIONS = every column between GROSS and the deductions total
    // (advances + late + interest + absent + PT)
    ws.getCell(`${COL.deductions}${n}`).value = { formula: `SUM(${COL.oldAdvance}${n}:${COL.pt}${n})` };
    // NET = GROSS − DEDUCTIONS
    ws.getCell(`${COL.netPayable}${n}`).value = { formula: `${COL.gross}${n}-${COL.deductions}${n}` };
    // Number formats.
    DAY_COLS.forEach((c) => { ws.getCell(`${c}${n}`).numFmt = DAYS; });
    MONEY_COLS.forEach((c) => { ws.getCell(`${c}${n}`).numFmt = MONEY; });
  });

  // Totals row (sum of every money column) so HR sees the payout at a glance.
  if (rows.length) {
    const first = 2;
    const last = rows.length + 1;
    const totals = ws.addRow({ designation: 'TOTAL' });
    const n = totals.number;
    MONEY_COLS.forEach((c) => {
      ws.getCell(`${c}${n}`).value = { formula: `SUM(${c}${first}:${c}${last})` };
      ws.getCell(`${c}${n}`).numFmt = MONEY;
    });
    totals.font = { bold: true };
    totals.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD4D4D8' } } }; });
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return wb;
}

/**
 * Download a month's payroll register as an .xlsx in the company layout.
 * @route GET /api/payroll/export-sheet?year=&month=  (HR/Admin)
 * @returns {application/vnd...spreadsheetml.sheet} filename payroll_<Month>-<Year>_<date>_<time>.xlsx
 */
const exportPayrollSheet = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;

  const profiles = await EmployeeProfile.find(employeeProfileScope(req))
    .select('employeeCode designation department user salaryStructure annualCtc ctcHistory dateOfJoining dateOfExit')
    .populate('user', 'firstName lastName isActive')
    .populate('salaryStructure')
    .sort('employeeCode');
  const active = profiles.filter((p) => p.user && p.user.isActive !== false);

  // ARREARS/BONUS is pulled from any saved payslip for the month (optional).
  const slips = await Payroll.find({ payPeriodYear: year, payPeriodMonth: month }).select('employee earnings.bonus');
  const bonusByEmp = new Map(slips.map((s) => [String(s.employee), (s.earnings && s.earnings.bonus) || 0]));

  const runs = await Promise.all(active.map((p) => computeEmployeeRun(p, year, month)));
  const rows = active.map((p, i) => buildPayrollSheetRow(
    i + 1,
    {
      name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim(),
      empNo: p.employeeCode,
      designation: p.designation,
    },
    runs[i],
    bonusByEmp.get(String(p._id)) || 0,
  ));

  const wb = buildPayrollWorkbook(rows, year, month);

  // Filename: payroll_<Month>-<Year>_<download date>_<download time>, timestamped in IST.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
  const dateSeg = `${parts.year}-${parts.month}-${parts.day}`;
  const timeSeg = `${parts.hour}-${parts.minute}-${parts.second}`;
  const fname = `payroll_${MONTH_NAMES[month]}-${year}_${dateSeg}_${timeSeg}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  await wb.xlsx.write(res);
  res.end();
});

// ===== Monthly payroll run =====
// "Initiate salaries" for a whole month: every active employee gets a Draft
// payslip for the period, seeded from their most recent payslip (new joiners
// get a blank draft for HR to fill in). Preview with GET, execute with POST.

async function buildRunRows(year, month, scope = {}) {
  const profiles = await EmployeeProfile.find(scope)
    .select('employeeCode designation department user salaryStructure annualCtc ctcHistory dateOfJoining dateOfExit')
    .populate('user', 'firstName lastName email isActive')
    .populate('salaryStructure')
    .sort('employeeCode');
  const active = profiles.filter((p) => p.user && p.user.isActive !== false);

  const existing = await Payroll.find({ payPeriodYear: year, payPeriodMonth: month });
  const existingByEmp = new Map(existing.map((p) => [String(p.employee), p]));

  // Most recent payslip per employee from any earlier period (small-org scale).
  const priorSlips = await Payroll.find({
    $or: [
      { payPeriodYear: { $lt: year } },
      { payPeriodYear: year, payPeriodMonth: { $lt: month } },
    ],
  }).sort({ payPeriodYear: -1, payPeriodMonth: -1 });
  const lastByEmp = new Map();
  priorSlips.forEach((p) => {
    const k = String(p.employee);
    if (!lastByEmp.has(k)) lastByEmp.set(k, p);
  });

  return active.map((p) => {
    const k = String(p._id);
    const cur = existingByEmp.get(k);
    const last = lastByEmp.get(k);
    // Whether payroll can be derived from a salary structure for THIS month
    // (has a structure assigned and a CTC in force after hike resolution).
    const hasSalarySetup = !!(p.salaryStructure && resolveCtcForMonth(p, year, month) > 0);
    // A Paid payslip is never overwritten; anything else can be recomputed as
    // long as there is a structure + CTC to recompute it from (a hand-entered or
    // copied payslip has no source to re-derive from, so it is left alone).
    const existingLocked = !!cur && cur.status === 'Paid';
    return {
      profile: p,
      existing: cur || null,
      last: last || null,
      hasSalarySetup,
      row: {
        employeeId: p._id,
        employeeCode: p.employeeCode,
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim(),
        designation: p.designation || '',
        department: p.department || '',
        existingStatus: cur ? cur.status : null,
        existingLocked,
        canRegenerate: !!cur && hasSalarySetup && !existingLocked,
        existingNetPay: cur ? cur.netPay : null,
        existingEmailed: !!(cur && cur.emailedAt),
        // Where this month's Draft will come from: the salary structure when set
        // up, else a copy of the employee's most recent payslip.
        source: hasSalarySetup
          ? `${p.salaryStructure.name} (structure)`
          : (last ? `${MONTH_NAMES[last.payPeriodMonth]} ${last.payPeriodYear}` : null),
        hasSalarySetup,
        lastNetPay: last ? last.netPay : null,
      },
    };
  });
}

/**
 * Preview the org-wide monthly payroll run (who is new vs already generated).
 * @route GET /api/payroll/run?year=&month=  (HR/Admin)
 * @param {number} [req.query.year] / [req.query.month]
 * @returns {{year, month, count, alreadyGenerated, toGenerate, regeneratable, rows}}
 */
// GET /api/payroll/run?year=&month=  — preview who gets what
const previewPayrollRun = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const rows = await buildRunRows(year, month, employeeProfileScope(req));
  res.json({
    year,
    month,
    count: rows.length,
    alreadyGenerated: rows.filter((r) => r.existing).length,
    toGenerate: rows.filter((r) => !r.existing).length,
    // Already-generated payslips HR may tick to recompute for this month.
    regeneratable: rows.filter((r) => r.row.canRegenerate).length,
    rows: rows.map((r) => r.row),
  });
});

/**
 * Execute the org-wide monthly run: create Draft payslips seeded from each
 * employee's most recent payslip (blank for new joiners). Existing payslips are
 * skipped unless their employee id is listed in `regenerate`, in which case they
 * are recomputed from structure + current attendance and reset to Draft (Paid
 * payslips are never overwritten).
 * @route POST /api/payroll/run  (HR/Admin)
 * @param {number} req.body.year - required
 * @param {number} req.body.month - required 1-12
 * @param {string[]|boolean} [req.body.regenerate] - EmployeeProfile ids to overwrite, or true/'all'
 * @returns {{year, month, created, regenerated, skippedExisting, regenerateBlocked, needsSetup, payslips}} (201)
 */
// POST /api/payroll/run  { year, month, regenerate }  — create/refresh the Draft payslips
const runPayroll = asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) {
    res.status(400);
    throw new Error('A valid year and month are required');
  }

  // Scope the run to the employees this admin may manage — an HR Manager runs
  // payroll only for their assigned people, the Backend for everyone.
  const rows = await buildRunRows(year, month, employeeProfileScope(req));
  const daysInMonth = new Date(year, month, 0).getDate();
  // Which already-generated payslips HR asked to overwrite.
  const regenAll = req.body.regenerate === true || req.body.regenerate === 'all';
  const regenSet = new Set(
    Array.isArray(req.body.regenerate) ? req.body.regenerate.map(String) : []
  );
  const created = [];
  const derivedCount = [];
  const copiedCount = [];
  const blank = [];
  const regenerated = [];
  const regenBlockedPaid = [];
  const regenBlockedNoSetup = [];
  let skippedExisting = 0;
  for (const r of rows) {
    if (r.existing) {
      const asked = regenAll ? r.row.canRegenerate : regenSet.has(String(r.profile._id));
      if (!asked) { skippedExisting += 1; continue; }
      // A disbursed payslip is a financial record — never rewrite it.
      if (r.existing.status === 'Paid') { regenBlockedPaid.push(r.row.name); continue; }
      // Nothing to recompute from: the payslip was hand-entered or copied, and
      // overwriting it would wipe HR's work.
      if (!r.hasSalarySetup) { regenBlockedNoSetup.push(r.row.name); continue; }
      const computed = await computeEmployeeRun(r.profile, year, month);
      if (computed.needsSetup) { regenBlockedNoSetup.push(r.row.name); continue; }
      const fromStatus = r.existing.status;
      const wasEmailed = !!r.existing.emailedAt;
      // Approved → Draft is picked up by the auditStatus plugin on save().
      Object.assign(r.existing, buildRunFields(r.profile, computed, r.existing, { rerun: true }));
      await r.existing.save();
      regenerated.push({
        name: r.row.name, netPay: r.existing.netPay, id: r.existing._id, fromStatus, wasEmailed,
      });
      continue;
    }

    // Preferred: derive the payslip from the employee's salary structure × CTC,
    // with attendance, the leave/late policy and loan EMIs applied as deductions
    // (same engine as the per-employee run and the editor's "fill from structure").
    if (r.hasSalarySetup) {
      const computed = await computeEmployeeRun(r.profile, year, month);
      if (!computed.needsSetup) {
        const payslip = await Payroll.create({
          employee: r.profile._id,
          payPeriodYear: year,
          payPeriodMonth: month,
          ...buildRunFields(r.profile, computed),
        });
        created.push({ name: r.row.name, netPay: payslip.netPay, id: payslip._id });
        derivedCount.push(r.row.name);
        continue;
      }
    }

    // Fallback (no salary structure/CTC set up): copy the employee's most recent
    // payslip, or leave a blank draft for a brand-new joiner to be filled in.
    const seed = r.last;
    const payslip = await Payroll.create({
      employee: r.profile._id,
      payPeriodYear: year,
      payPeriodMonth: month,
      workingDays: daysInMonth,
      paidDays: daysInMonth,
      lopDays: 0,
      earnings: seed ? seed.earnings?.toObject?.() || seed.earnings : {},
      deductions: seed ? seed.deductions?.toObject?.() || seed.deductions : {},
      employerContributions: seed ? seed.employerContributions?.toObject?.() || seed.employerContributions : {},
      status: 'Draft',
      remarks: seed
        ? `Payroll run: copied from ${MONTH_NAMES[seed.payPeriodMonth]} ${seed.payPeriodYear} (no salary structure set)`
        : 'Payroll run: no salary structure or earlier payslip - set the salary components',
    });
    created.push({ name: r.row.name, netPay: payslip.netPay, id: payslip._id });
    if (seed) copiedCount.push(r.row.name);
    else blank.push(r.row.name);
  }

  res.status(201).json({
    year,
    month,
    created: created.length,
    derived: derivedCount.length,
    copiedFromLast: copiedCount.length,
    skippedExisting,
    regenerated: regenerated.length,
    regeneratedFromApproved: regenerated.filter((p) => p.fromStatus === 'Approved').length,
    // Their already-sent PDF is now stale — HR should resend after reviewing.
    regeneratedEmailed: regenerated.filter((p) => p.wasEmailed).map((p) => p.name),
    regenerateBlocked: { paid: regenBlockedPaid, noSetup: regenBlockedNoSetup },
    needsSetup: blank,
    payslips: created.concat(regenerated.map((p) => ({ name: p.name, netPay: p.netPay, id: p.id }))),
  });
});

// ===== Per-employee payroll run (calendar view) =====
// Salary comes from the employee's assigned SalaryStructure percentages ×
// annual CTC, paid IN FULL — no earning is reduced by attendance. Days not
// worked (derived from their punch-in/out records) are recovered as the
// `lopDeduction`, alongside the late penalty and active loan/advance EMIs.

// Attendance policy constants. The lateness arithmetic — including the
// SuperAdmin-set cut-off time and grace window it judges against — comes from
// utils/workday.js, shared with the attendance + manager controllers.
// Both monthly allowances below are a full month's entitlement and are prorated
// by the days an employee was actually on the payroll that month (see
// prorateAllowance in computeEmployeeRun) — a mid-month joiner gets a part quota.
const PAID_LEAVE_QUOTA = 2;      // paid leave days granted each month
const LATE_ALLOWANCE = 5;        // free late arrivals each month
const LATE_THRESHOLD_BASIC = 25000; // monthly Basic cut-off for the penalty rate
const LATE_RATE_LOW = 200;       // ₹/day when monthly Basic < threshold
const LATE_RATE_HIGH = 400;      // ₹/day when monthly Basic >= threshold

// Statutory deduction constants (employee side). Used to auto-fill standard
// deductions when deriving a payslip from a salary structure. All editable by HR.
// The company does NOT currently run PF/EPF or ESI, so both are auto-filled as
// zero everywhere (editor "fill from structure", the org run, and the register).
// Flip these flags to re-enable the statutory calc — the rates below still apply.
const EPF_ENABLED = false;          // PF/EPF deduction currently not run
const ESIC_ENABLED = false;         // ESI deduction currently not run
const EPF_EMP_RATE = 0.12;          // Employee PF: 12% of Basic
const ESIC_EMP_RATE = 0.0075;       // Employee ESIC: 0.75% of gross
const ESIC_WAGE_CEILING = 21000;    // ESIC applies only when monthly gross <= this
const PROFESSIONAL_TAX = 200;       // Flat monthly professional tax

// Employer-side contributions. These are a cost to the company and are NEVER
// deducted from the employee — the payslip prints them so the full cost of
// employment is visible. PF and ESI follow the same switches as the employee
// side above: a company that does not run PF has no employer PF share either.
const EPF_ER_RATE = 0.12;         // Employer PF share: 12% of Basic, same as the employee's
const EPS_RATE = 0.0833;          // The pension slice carved out of that 12%
const EPS_WAGE_CEILING = 15000;   // Pension is computed on Basic capped here
const ESIC_ER_RATE = 0.0325;      // Employer ESIC: 3.25% of gross
// Gratuity is a provision rather than a deduction, and is payable under the
// Payment of Gratuity Act after five years' service — so it applies whether or
// not PF does, and has its own switch. 4.81% ≈ 15 days' Basic a year over 12
// months. Set PAYROLL_GRATUITY_ENABLED=false if the company does not provision it.
const GRATUITY_RATE = 0.0481;
const GRATUITY_ENABLED = !['0', 'false', 'no', 'off']
  .includes(String(process.env.PAYROLL_GRATUITY_ENABLED ?? 'true').toLowerCase());

// The six salary-structure components. ESIC is assessed on these alone — the
// incentive/bonus/overtime lines are not part of the structure gross — so the
// list lives here rather than being spelled out at each site that needs it.
const STRUCTURE_COMPONENT_KEYS = [
  'basic', 'hra', 'specialAllowance', 'conveyanceAllowance', 'medicalAllowance', 'lta',
];
const structureGross = (earnings) =>
  STRUCTURE_COMPONENT_KEYS.reduce((a, k) => a + (Number(earnings?.[k]) || 0), 0);

/**
 * Employer contributions for one month, from the same component base the
 * employee-side deductions use.
 * @param {number} basic - monthly Basic
 * @param {number} gross - monthly gross of the structure components
 * @returns {{epf: number, eps: number, esic: number, gratuity: number}}
 */
function employerContributionsFor(basic, gross) {
  const b = Number(basic) || 0;
  const g = Number(gross) || 0;
  // The pension slice comes out of the 12% first; whatever remains goes to EPF.
  const eps = EPF_ENABLED ? Math.round(Math.min(b, EPS_WAGE_CEILING) * EPS_RATE) : 0;
  return {
    epf: EPF_ENABLED ? Math.max(0, Math.round(b * EPF_ER_RATE) - eps) : 0,
    eps,
    esic: ESIC_ENABLED && g <= ESIC_WAGE_CEILING ? Math.round(g * ESIC_ER_RATE) : 0,
    gratuity: GRATUITY_ENABLED ? Math.round(b * GRATUITY_RATE) : 0,
  };
}

/**
 * Stamp a payslip's employer contributions from its own earnings.
 *
 * Nothing here is ever hand-entered, so it is derived on every write rather than
 * taken from the request — otherwise a manually created or edited slip would
 * carry zeros while a run-generated one for the same employee did not.
 * @param {Object} payslip - Payroll doc, mutated in place.
 */
function applyEmployerContributions(payslip) {
  const e = payslip.earnings?.toObject?.() || payslip.earnings || {};
  payslip.employerContributions = employerContributionsFor(e.basic, structureGross(e));
}

// Derive monthly earnings + standard statutory deductions from a salary
// structure's component percentages applied to an annual CTC. Pure +
// side-effect-free so it can back both the payroll run and the manual payslip
// editor's "fill from structure" action.
//
// Earnings are ALWAYS the full monthly value — attendance never shrinks Basic
// or any other component. Days not worked are recovered on the deductions side
// as `lopDeduction`, one day's salary per unpaid day.
function deriveSalary(components, annualCtc, paidDays, daysInMonth) {
  const c = components || {};
  const dim = Number(daysInMonth) || 30;
  const comp = (pct) => Math.round(((Number(pct) || 0) / 100) * (Number(annualCtc) || 0) / 12);
  const earnings = {
    basic: comp(c.basicPct),
    hra: comp(c.hraPct),
    specialAllowance: comp(c.specialAllowancePct),
    conveyanceAllowance: comp(c.conveyancePct),
    medicalAllowance: comp(c.medicalPct),
    lta: comp(c.ltaPct),
  };
  const gross = Object.values(earnings).reduce((a, v) => a + v, 0);
  const unpaidDays = Math.min(dim, Math.max(0, dim - (Number(paidDays) ?? dim)));
  const deductions = {
    epf: EPF_ENABLED ? Math.round(earnings.basic * EPF_EMP_RATE) : 0,
    esic: ESIC_ENABLED && gross <= ESIC_WAGE_CEILING ? Math.round(gross * ESIC_EMP_RATE) : 0,
    professionalTax: PROFESSIONAL_TAX,
    lopDeduction: Math.round((gross / dim) * unpaidDays),
  };
  return {
    earnings,
    deductions,
    gross,
    employerContributions: employerContributionsFor(earnings.basic, gross),
  };
}

// The CTC in force for a given pay month, resolved from the employee's hike
// history: the latest revision whose effective month is on/before the run month
// wins; a month before the first revision uses that revision's previousCtc;
// employees with no history fall back to their current annualCtc.
function resolveCtcForMonth(profile, year, month) {
  const hist = (profile.ctcHistory || []).filter((r) => r.newCtc != null && r.effectiveYear);
  if (!hist.length) return profile.annualCtc || 0;
  const key = (y, m) => Number(y) * 12 + (Number(m || 1) - 1);
  const target = key(year, month);
  const asc = hist.slice().sort((a, b) => key(a.effectiveYear, a.effectiveMonth) - key(b.effectiveYear, b.effectiveMonth));
  const applicable = asc.filter((r) => key(r.effectiveYear, r.effectiveMonth) <= target);
  if (applicable.length) return applicable[applicable.length - 1].newCtc;
  return asc[0].previousCtc != null ? asc[0].previousCtc : (profile.annualCtc || 0);
}

async function computeEmployeeRun(profile, year, month) {
  const { start, end } = monthRangeIST(year, month);
  const records = await Attendance.find({ employee: profile._id, date: { $gte: start, $lt: end } });
  const daysInMonth = new Date(year, month, 0).getDate();
  const count = (s) => records.filter((r) => r.status === s).length;
  const halfDay = count('HalfDay');
  const absent = count('Absent');
  const onLeaveDays = count('OnLeave');

  // ----- No-punch working days → LOP (unless regularised) -----
  // A working day (not a Sunday or listed holiday) that is already over but has
  // NO punch-in and NO punch-out — and no leave / holiday / weekly-off credit —
  // is treated as Loss of Pay. Regularising the day writes a check-in (or a
  // Present/Leave status), which credits it back. These days usually have no
  // attendance record at all, so they aren't caught by the `absent` count above.
  const holidays = await Holiday.find({ date: { $gte: start, $lt: end } }).select('date type').lean().catch(() => []);
  const holidayKeys = new Set((holidays || []).map((h) => ymdIST(h.date)));
  // Org-wide comp-off days — the subset of holidays that, like a Sunday, pays
  // double when it is actually worked (once approved). See utils/restDay.js.
  const compOffKeys = compOffKeysFor(holidays);
  const recByKey = new Map(records.map((r) => [ymdIST(r.date), r]));
  const CREDITED = new Set(['Present', 'HalfDay', 'OnLeave', 'Holiday', 'WeeklyOff']);
  const todayKey = ymdIST(new Date());
  const joinKey = profile.dateOfJoining ? ymdIST(profile.dateOfJoining) : null;
  const exitKey = profile.dateOfExit ? ymdIST(profile.dateOfExit) : null;

  // ----- Days this employee was on the payroll this month -----
  // Salary is spread over CALENDAR days — Sundays and holidays are paid — so a
  // full month is `daysInMonth` (July = 31). A mid-month joiner (or leaver) is
  // only entitled to the days from their joining date up to their exit date, so
  // their paid days are capped at that count: joined 5 July → 27 of 31 days.
  // The per-day rate stays monthly gross ÷ daysInMonth regardless, so a day of
  // excess leave or absence costs the same (salary ÷ 31) for everyone.
  const { eligibleDays, notEmployedDays } = daysOnPayroll(profile, year, month);

  let noPunchDays = 0;
  for (let i = 0; i < daysInMonth; i += 1) {
    // Midday IST anchor so the calendar day is unambiguous.
    const key = ymdIST(new Date(start.getTime() + i * 86400000 + 12 * 3600000));
    if (key >= todayKey) continue;                // today or future — not yet due (may still punch in)
    if (joinKey && key < joinKey) continue;       // before this employee joined
    if (exitKey && key > exitKey) continue;       // after they exited
    const [Y, M, D] = key.split('-').map(Number);
    if (new Date(Date.UTC(Y, M - 1, D)).getUTCDay() === 0) continue; // Sunday
    if (holidayKeys.has(key)) continue;                              // holiday
    const rec = recByKey.get(key);
    if (!rec) { noPunchDays += 1; continue; }     // no record at all → no punch
    if (rec.status === 'Absent') continue;        // already in `absent`
    if (rec.checkIn) continue;                    // punched in (incl. regularised)
    if (CREDITED.has(rec.status)) continue;       // leave / holiday / present credit
    noPunchDays += 1;                             // record exists but no punch/credit
  }

  // ----- Prorated monthly allowances -----
  // The paid-leave quota and the free-late allowance are a FULL month's
  // entitlement, so an employee who was only on the payroll for part of the month
  // (joined or exited mid-month) earns them in proportion to those days. The leave
  // module prorates the same quota the same way (shared prorateAllowance), so the
  // paid/LOP split an employee is shown when applying matches their payslip.
  const paidLeaveQuota = prorateAllowance(PAID_LEAVE_QUOTA, eligibleDays, daysInMonth);
  const lateAllowance = prorateAllowance(LATE_ALLOWANCE, eligibleDays, daysInMonth);

  // ----- Monthly paid-leave quota (2 days, prorated) -----
  // Leave days beyond the quota become LOP; unused quota converts to extra pay
  // (leave incentive) at one day's salary each. Settled monthly, never carried.
  const excessLeave = Math.max(0, onLeaveDays - paidLeaveQuota);
  const unusedLeave = Math.max(0, paidLeaveQuota - onLeaveDays);

  // ----- Rest-day duty paid at DOUBLE -----
  // A Sunday or an org-wide Comp Off day is already paid inside the monthly
  // salary (pay is spread over calendar days), so working one is settled by
  // paying ONE more day — that is what makes the day 2×. Only days HR or the
  // reporting manager approved count; an unapproved or rejected rest day is paid
  // normally, and so is any rest day nobody worked. The rest-day test is
  // re-applied here rather than trusted from approval time, so un-declaring a
  // comp-off day can't leave paid-out days behind.
  const doublePayDays = approvedDoublePayDays(records, compOffKeys);
  const pendingDoublePayDays = +records
    .reduce((a, r) => a + (doublePayState(r, compOffKeys) === 'Pending' ? 1 : 0), 0).toFixed(1);

  // ----- Late arrivals (check-in past the late cut-off) on worked days -----
  const lateDays = records.filter(
    (r) => ['Present', 'HalfDay'].includes(r.status) && lateMinutes(r) > 0
  ).length;
  const excessLate = Math.max(0, lateDays - lateAllowance);

  // Paid days: every day the employee was on the payroll (all calendar days for a
  // full month, else only the days from joining to exit) except Absent (full LOP),
  // no-punch days (full LOP unless regularised), half of each HalfDay, and leave
  // days beyond the monthly paid quota.
  const paidDays = +Math.max(0, eligibleDays - absent - noPunchDays - 0.5 * halfDay - excessLeave).toFixed(1);
  const lopDays = +(eligibleDays - paidDays).toFixed(1);
  // Unpaid days out of the whole month = LOP + the days before joining / after
  // exit. This is what the payroll register charges back, since that sheet shows
  // the full monthly salary and recovers everything not worked as one deduction.
  const unpaidDays = +(daysInMonth - paidDays).toFixed(1);

  // Active loan/advance recovery for this employee (Loan.employee is the User).
  // Salary advances are split out from other loans because the salary slip
  // prints "LOAN" and "Salary In Advance" as two separate deduction lines.
  const userId = profile.user?._id || profile.user;
  const loans = await Loan.find({ employee: userId, status: { $in: ['Approved', 'Active'] } });
  const emiOf = (pred) => Math.round(loans.filter(pred).reduce((a, l) => a + (l.emi || 0), 0));
  const salaryAdvance = emiOf((l) => l.type === 'Salary Advance');
  const loanRecovery = emiOf((l) => l.type !== 'Salary Advance');

  const st = profile.salaryStructure; // populated
  // CTC effective for THIS pay month (honours future-dated / historical hikes).
  const ctc = resolveCtcForMonth(profile, year, month);
  let earnings = null;
  let statutoryDeductions = { epf: 0, esic: 0, professionalTax: 0 };
  let employerContributions = { epf: 0, eps: 0, esic: 0, gratuity: 0 };
  let monthlyBasic = 0;   // full (unprorated) Basic — drives the late-penalty rate
  let perDayPay = 0;      // full monthly gross ÷ days in month — one day's pay
  if (st && ctc > 0) {
    const c = st.components || {};
    // Earnings are the FULL monthly value of each component — attendance never
    // reduces Basic (or any other head). Days not worked are recovered below as
    // `lopDeduction`, so the slip shows the real salary against a visible cut.
    const comp = (pct) => Math.round(((pct || 0) / 100) * ctc / 12);
    const compFull = (pct) => ((pct || 0) / 100) * ctc / 12;
    monthlyBasic = compFull(c.basicPct);
    const fullGross = [c.basicPct, c.hraPct, c.specialAllowancePct, c.conveyancePct, c.medicalPct, c.ltaPct]
      .reduce((a, pct) => a + compFull(pct), 0);
    perDayPay = daysInMonth ? fullGross / daysInMonth : 0;
    earnings = {
      basic: comp(c.basicPct),
      hra: comp(c.hraPct),
      specialAllowance: comp(c.specialAllowancePct),
      conveyanceAllowance: comp(c.conveyancePct),
      medicalAllowance: comp(c.medicalPct),
      lta: comp(c.ltaPct),
      // Unused paid-leave quota paid out at one day's salary each.
      leaveIncentive: Math.round(unusedLeave * perDayPay),
      // One extra day's pay per approved Sunday / comp-off day worked — the day
      // is already paid once in the salary above, so this is what doubles it.
      doubleDayPay: Math.round(doublePayDays * perDayPay),
    };
    // Standard statutory deductions on the same component base used by the
    // manual editor's derive, so all payroll paths fill the same values.
    const baseGross = structureGross(earnings);
    statutoryDeductions = {
      epf: EPF_ENABLED ? Math.round(earnings.basic * EPF_EMP_RATE) : 0,
      esic: ESIC_ENABLED && baseGross <= ESIC_WAGE_CEILING ? Math.round(baseGross * ESIC_EMP_RATE) : 0,
      professionalTax: PROFESSIONAL_TAX,
    };
    employerContributions = employerContributionsFor(earnings.basic, baseGross);
  }
  const leaveIncentive = earnings ? earnings.leaveIncentive : 0;
  const doubleDayPay = earnings ? earnings.doubleDayPay : 0;
  const gross = earnings ? Object.values(earnings).reduce((a, v) => a + v, 0) : 0;

  // Late-arrival penalty for days beyond the monthly allowance. This is a flat
  // per-day amount, so it applies (and is shown to the employee) even before the
  // salary is set up — unlike the leave incentive, which needs a per-day pay to
  // value. When Basic isn't known yet, monthlyBasic is 0 → the lower ₹200 rate.
  const lateRate = monthlyBasic < LATE_THRESHOLD_BASIC ? LATE_RATE_LOW : LATE_RATE_HIGH;
  const latePenalty = excessLate * lateRate;

  // ----- Loss of pay recovered as a deduction -----
  // Earnings above are the full monthly salary, so everything the employee did
  // not earn is charged back here at one day's pay: LOP days (absent, no-punch,
  // half days, leave beyond the quota) plus any days before joining / after exit.
  // Same basis the payroll register already uses for its ABSENT AMOUNT column, so the
  // two documents agree. Zero before salary setup, since perDayPay is then 0.
  const lopDeduction = Math.round(unpaidDays * perDayPay);

  // ----- Emergency leave charged at DOUBLE -----
  // Emergency leave is granted without approval, so misuse is controlled after
  // the fact: a manager or HR can mark a day "double cut", making it cost two
  // days' salary in total. The day has already cost whatever its paid/LOP split
  // says, so this line is only the balance still owed to reach 2×:
  //     days owed = 2 × paidDays + lopDays        (per request)
  // A day inside the paid quota therefore costs 2 days (it was free), while one
  // already beyond the quota costs 1 more on top of the day it had lost.
  const doubleCutLeaves = await LeaveRequest.find({
    employee: profile._id,
    leaveType: EMERGENCY_LEAVE,
    status: 'Approved',
    doubleCut: true,
    startDate: { $gte: start, $lt: end },
  }).select('paidDays lopDays totalDays startDate').lean().catch(() => []);
  const doubleCutDays = +(doubleCutLeaves || [])
    .reduce((a, l) => a + 2 * (l.paidDays || 0) + (l.lopDays || 0), 0).toFixed(1);
  const emergencyPenalty = Math.round(doubleCutDays * perDayPay);

  // Working-hours roll-up. A "worked day" is any day with real punch hours.
  // Sundays and holidays are excluded from the average — unless the employee
  // actually worked that day, in which case its hours count and the day is
  // earned back as a compensatory off (comp-off).
  const isRestDay = (r) =>
    isRestDayRecord(r, compOffKeys) || r.status === 'Holiday' || r.status === 'WeeklyOff';
  const workedRecords = records.filter((r) => (r.hoursWorked || 0) > 0);
  const totalHours = +workedRecords.reduce((a, r) => a + (r.hoursWorked || 0), 0).toFixed(2);
  const daysPresent = workedRecords.length;
  const avgHours = daysPresent ? +(totalHours / daysPresent).toFixed(2) : 0;
  const compOff = workedRecords.filter(isRestDay).length;

  return {
    daysInMonth,
    counts: {
      present: count('Present'), halfDay, onLeave: count('OnLeave'),
      absent, noPunchAbsent: noPunchDays, weeklyOff: count('WeeklyOff'), holiday: count('Holiday'),
    },
    hours: { daysPresent, totalHours, avgHours, compOff },
    // Attendance-policy roll-up: monthly paid-leave quota + late allowance. Both
    // allowances are the effective (prorated) entitlement for this employee-month;
    // the full-month figures are alongside so the UI can explain a short quota.
    policy: {
      paidLeaveQuota,       // prorated for a mid-month joiner / leaver
      fullPaidLeaveQuota: PAID_LEAVE_QUOTA,
      leaveTaken: onLeaveDays,
      excessLeave,          // leave days beyond the quota → added to LOP
      unusedLeave,          // quota not used → paid out as leaveIncentive
      leaveIncentive,
      noPunchDays,          // past working days with no punch (LOP unless regularised)
      // Sunday / comp-off days worked. Only the approved ones are paid; the
      // pending count is surfaced so HR can see money still waiting on a decision.
      doublePayDays,
      pendingDoublePayDays,
      doubleDayPay,
      lateAllowance,        // prorated for a mid-month joiner / leaver
      fullLateAllowance: LATE_ALLOWANCE,
      // The cut-off these late days were judged against, so the employee's own
      // summary can state the rule instead of assuming 10:00 AM.
      latePolicy: getLatePolicy(),
      lateDays,
      excessLate,           // late days beyond the allowance → penalised
      lateRate,
      latePenalty,
      // Full monthly salary is paid, then the days not worked are charged back.
      perDayPay: Math.round(perDayPay),
      lopDeduction,
      // Emergency leave a manager/HR charged at double pay this month.
      doubleCutLeaves: (doubleCutLeaves || []).length,
      doubleCutDays,
      emergencyPenalty,
      monthlyBasic: Math.round(monthlyBasic),
      // Part-month context, so a short quota can be explained wherever only the
      // policy roll-up is available (e.g. the employee's own summary).
      daysInMonth,
      eligibleDays,
      prorated: notEmployedDays > 0,
    },
    paidDays, lopDays,
    // Proration base: eligibleDays are the days on the payroll this month (mid-month
    // joiners/leavers get fewer), while daysInMonth stays the per-day divisor.
    eligibleDays, notEmployedDays, unpaidDays,
    doublePayDays, doubleDayPay,
    ctc, // CTC effective for this pay month (post hike resolution)
    statutoryDeductions, // EPF / ESIC / PT derived from the components
    employerContributions, // company-side PF/EPS/ESI/gratuity, not deducted from pay
    loans: loans.map((l) => ({ _id: l._id, type: l.type, emi: l.emi, balance: l.balance, status: l.status })),
    loanRecovery,
    salaryAdvance,
    lopDeduction,
    latePenalty,
    emergencyPenalty,
    earnings, gross,
    // Take-home estimate only once salary exists; before that gross is 0 and a
    // net would be a meaningless negative (the late penalty is still shown above).
    estimatedNet: earnings
      ? gross - loanRecovery - salaryAdvance - lopDeduction - latePenalty - emergencyPenalty
      : 0,
    needsSetup: !earnings,
  };
}

/**
 * Build the payslip fields for a (re)run from a computeEmployeeRun() result.
 * Shared by the org-wide run and the per-employee run so both write the same
 * shape. When `existing` is given (a re-generate), the values the engine cannot
 * derive - HR-entered bonus/overtime/other earnings, TDS and other deductions -
 * are carried over; everything else is recomputed from structure + attendance.
 * @param {Object} profile - EmployeeProfile with salaryStructure populated
 * @param {Object} computed - computeEmployeeRun() result (needsSetup must be false)
 * @param {Object|null} [existing] - the payslip being overwritten, if any
 * @param {{rerun?: boolean}} [opts] - rerun marks the remarks as an overwrite
 * @returns {Object} fields to Object.assign onto a Payroll doc
 */
function buildRunFields(profile, computed, existing = null, { rerun = false } = {}) {
  const p = computed.policy;
  const prevEarnings = existing?.earnings?.toObject?.() || existing?.earnings || {};
  const prevDeductions = existing?.deductions?.toObject?.() || existing?.deductions || {};
  return {
    workingDays: computed.daysInMonth,
    paidDays: computed.paidDays,
    lopDays: computed.lopDays,
    halfDays: computed.counts.halfDay,
    lateDays: p.lateDays,
    additionalPaidDays: p.unusedLeave,
    // Salary in force for this pay month, frozen so a later hike cannot change
    // what an already-issued slip reprints.
    monthlySalary: Math.round((computed.ctc || 0) / 12),
    annualCtc: computed.ctc || 0,
    earnings: {
      // Keep the manually entered earnings the run cannot derive.
      bonus: prevEarnings.bonus || 0,
      overtime: prevEarnings.overtime || 0,
      otherEarnings: prevEarnings.otherEarnings || 0,
      ...computed.earnings,
    },
    // Company-side cost, fully derived — nothing here is ever hand-entered, so
    // it is recomputed outright rather than merged with what was there before.
    employerContributions: computed.employerContributions,
    deductions: {
      // Preserve HR-entered non-derivable deductions (TDS, other), (re)compute
      // the deterministic ones from the structure/attendance.
      ...prevDeductions,
      epf: computed.statutoryDeductions.epf,
      esic: computed.statutoryDeductions.esic,
      professionalTax: computed.statutoryDeductions.professionalTax,
      loanRecovery: computed.loanRecovery,
      salaryAdvance: computed.salaryAdvance,
      lopDeduction: computed.lopDeduction,
      latePenalty: computed.latePenalty,
      emergencyPenalty: computed.emergencyPenalty,
    },
    status: 'Draft',
    remarks: `${rerun ? 'Re-run' : 'Payroll run'}: ${profile.salaryStructure.name} @ ₹${(computed.ctc || 0).toLocaleString('en-IN')} CTC · ${computed.paidDays}/${computed.daysInMonth} paid days · loan EMI ₹${computed.loanRecovery}`
      + (computed.salaryAdvance ? ` · advance EMI ₹${computed.salaryAdvance}` : '')
      + (computed.notEmployedDays ? ` (on payroll ${computed.eligibleDays}/${computed.daysInMonth} days)` : '')
      + (computed.lopDeduction ? ` · ${computed.unpaidDays}d unpaid recovered (₹${computed.lopDeduction} @ ₹${p.perDayPay}/d)` : '')
      + ` · leave ${p.leaveTaken}/${p.paidLeaveQuota}`
      + (p.excessLeave ? ` (${p.excessLeave}d LOP)` : p.unusedLeave ? ` (₹${p.leaveIncentive} incentive)` : '')
      + (p.noPunchDays ? ` · no-punch ${p.noPunchDays}d LOP` : '')
      + (p.doublePayDays ? ` · rest-day duty ${p.doublePayDays}d at 2× (₹${p.doubleDayPay})` : '')
      + ` · late ${p.lateDays}/${p.lateAllowance}` + (p.excessLate ? ` (₹${p.latePenalty} penalty @ ₹${p.lateRate}/d)` : '')
      + (p.emergencyPenalty ? ` · emergency double-cut ${p.doubleCutLeaves}× (₹${p.emergencyPenalty})` : '')
      // Amount edits are not covered by the status audit log, so record the
      // overwrite on the payslip itself.
      + (rerun && existing ? ` · re-generated over ${existing.status} on ${new Date().toLocaleDateString('en-IN')}` : ''),
  };
}

/**
 * Preview one employee's computed payroll for a month (structure × attendance × loans).
 * @route GET /api/payroll/run-employee?employee=&year=&month=  (HR/Admin)
 * @param {string} req.query.employee - EmployeeProfile id (required)
 * @param {number} [req.query.year] / [req.query.month]
 * @returns {{year, month, employee, computed, payslip}}
 */
// GET /api/payroll/run-employee?employee=&year=&month=
const previewEmployeeRun = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const profile = await EmployeeProfile.findById(req.query.employee)
    .select('employeeCode designation department user salaryStructure annualCtc ctcHistory dateOfJoining dateOfExit')
    .populate('user', 'firstName lastName email')
    .populate('salaryStructure');
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  const computed = await computeEmployeeRun(profile, year, month);
  const payslip = await Payroll.findOne({ employee: profile._id, payPeriodYear: year, payPeriodMonth: month });
  res.json({ year, month, employee: profile, computed, payslip });
});

/**
 * Create or refresh one employee's Draft payslip from structure + attendance + loans.
 * @route POST /api/payroll/run-employee  (HR/Admin)
 * @param {string} req.body.employee - EmployeeProfile id
 * @param {number} req.body.year - required
 * @param {number} req.body.month - required 1-12
 * @returns {{payslip, computed}} (201); 400 if salary not set up or the slip is already Paid
 */
// POST /api/payroll/run-employee  { employee, year, month }
// Create or refresh the month's Draft payslip from structure + attendance + loans.
// An Approved payslip is recomputed and drops back to Draft; Paid is locked.
const runEmployeePayroll = asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) {
    res.status(400);
    throw new Error('A valid year and month are required');
  }
  const profile = await EmployeeProfile.findById(req.body.employee)
    .populate('user', 'firstName lastName')
    .populate('salaryStructure');
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  const computed = await computeEmployeeRun(profile, year, month);
  if (computed.needsSetup) {
    res.status(400);
    throw new Error('Assign a salary structure and annual CTC to this employee first.');
  }

  let payslip = await Payroll.findOne({ employee: profile._id, payPeriodYear: year, payPeriodMonth: month });
  // A disbursed payslip is a financial record; an Approved one can still be
  // recomputed (it drops back to Draft, which the audit log records).
  if (payslip && payslip.status === 'Paid') {
    res.status(400);
    throw new Error(`The ${MONTH_NAMES[month]} payslip is already ${payslip.status} - it can't be regenerated.`);
  }
  const fields = buildRunFields(profile, computed, payslip, { rerun: !!payslip });
  if (payslip) {
    Object.assign(payslip, fields);
    await payslip.save();
  } else {
    payslip = await Payroll.create({ employee: profile._id, payPeriodYear: year, payPeriodMonth: month, ...fields });
  }
  res.status(201).json({ payslip, computed });
});

/**
 * Get a single payslip by id.
 * @route GET /api/payroll/:id  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {{payslip: Object}}
 */
// GET /api/payroll/:id  (HR/Admin)
const getPayslip = asyncHandler(async (req, res) => {
  // Deliberately NOT the PDF populate spec — this is a JSON response and must
  // not carry the employee's Aadhaar number.
  const payslip = await Payroll.findById(req.params.id).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  res.json({ payslip });
});

/**
 * Manually create a payslip.
 * @route POST /api/payroll  (HR/Admin)
 * @param {string} req.body.employee - EmployeeProfile id (required)
 * @param {number} req.body.payPeriodYear / req.body.payPeriodMonth - required
 * @returns {{payslip: Object}} (201)
 */
// POST /api/payroll  (HR/Admin)
const createPayslip = asyncHandler(async (req, res) => {
  const { employee, payPeriodYear, payPeriodMonth } = req.body;
  if (!employee || !payPeriodYear || !payPeriodMonth) {
    res.status(400);
    throw new Error('employee, payPeriodYear, payPeriodMonth are required');
  }
  const profile = await EmployeeProfile.findById(employee).select('hrPartner company');
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  const payslip = new Payroll(req.body);
  applyEmployerContributions(payslip);
  await payslip.save();
  res.status(201).json({ payslip });
});

/**
 * Update a payslip (not once Paid; identity fields immutable).
 * @route PUT /api/payroll/:id  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @param {Object} req.body - fields to update
 * @returns {{payslip: Object}}
 */
// PUT /api/payroll/:id  (HR/Admin)
const updatePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (payslip.status === 'Paid') {
    res.status(400);
    throw new Error('Paid payslips cannot be edited');
  }
  // Don't allow changing identity fields
  delete req.body.employee;
  delete req.body.payPeriodYear;
  delete req.body.payPeriodMonth;

  // Identity fields aside, the release state is HR's to move through the proper
  // transitions — a PUT must not be able to hand a payslip over.
  delete req.body.release;

  Object.assign(payslip, req.body);
  applyEmployerContributions(payslip);

  // Editing a released payslip pulls it back: the employee must not be able to
  // download a half-corrected document, so HR finalises again when they are done.
  if (isReleased(payslip)) {
    payslip.release.status = 'Approved';
    payslip.release.finalisedAt = undefined;
    payslip.release.finalisedBy = undefined;
    logRelease(payslip, 'EditedAfterRelease', req.user, 'Edited after release — needs finalising again');
  }

  await payslip.save();
  res.json({ payslip });
});

/**
 * Approve a Draft/OnHold payslip.
 * @route PATCH /api/payroll/:id/approve  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {{payslip: Object}} with status Approved
 */
// PATCH /api/payroll/:id/approve  (HR/Admin)
const approvePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (payslip.status !== 'Draft' && payslip.status !== 'OnHold') {
    res.status(400);
    throw new Error(`Cannot approve from status ${payslip.status}`);
  }
  payslip.status = 'Approved';
  await payslip.save();
  res.json({ payslip });
});

/**
 * Mark an Approved payslip as Paid.
 * @route PATCH /api/payroll/:id/pay  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @param {string} [req.body.paymentDate] / [req.body.paymentReference]
 * @returns {{payslip: Object}} with status Paid
 */
// PATCH /api/payroll/:id/pay  (HR/Admin)
const markPayslipPaid = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (payslip.status !== 'Approved') {
    res.status(400);
    throw new Error('Payslip must be Approved before it can be marked Paid');
  }
  payslip.status = 'Paid';
  payslip.paymentDate = req.body.paymentDate || new Date();
  if (req.body.paymentReference) payslip.paymentReference = req.body.paymentReference;
  await payslip.save();
  res.json({ payslip });
});

// Employee data the salary slip prints. Every PDF route (admin download,
// employee download, email, public link) uses this same spec so all four render
// an identical slip. `aadhaar` is select:false on the model, so it has to be
// asked for explicitly or the slip's Aadhaar row comes out blank. It is fetched
// only here — never for the JSON endpoints, so the number reaches the printed
// document without entering an API payload.
const PAYSLIP_PDF_POPULATE = {
  path: 'employee',
  select: '+aadhaar',
  populate: { path: 'user', select: 'firstName lastName email' },
};

/**
 * Download a payslip PDF.
 * @route GET /api/payroll/:id/pdf  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {application/pdf}
 */
// GET /api/payroll/:id/pdf  (HR/Admin)
const downloadPayslipPdf = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate(PAYSLIP_PDF_POPULATE);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  await streamPayslipPdf(payslip, res);
});

/**
 * Download the caller's own payslip PDF (Approved/Paid only).
 * @route GET /api/payroll/me/:id/pdf  (employee)
 * @param {string} req.params.id - payslip id (must belong to caller)
 * @returns {application/pdf}
 */
// GET /api/payroll/me/:id/pdf  (employee — own payslips only, Approved or Paid)
const downloadMyPayslipPdf = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  const payslip = await Payroll.findOne({
    _id: req.params.id,
    employee: profile._id,
    status: { $in: ['Approved', 'Paid'] },
  }).populate(PAYSLIP_PDF_POPULATE);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  // A payslip is HR's document until they release it. Everything up to that
  // point — requesting, HR's corrections, the preview — happens without the
  // employee holding a copy.
  if (!isReleased(payslip)) {
    res.status(403);
    const state = payslip.release?.status || 'NotRequested';
    throw new Error(state === 'NotRequested'
      ? 'Request this payslip first — HR will release it to you.'
      : 'HR is still preparing this payslip. You can download it once it is final.');
  }
  await streamPayslipPdf(payslip, res);
});

async function streamPayslipPdf(payslip, res) {
  const buffer = await renderPayslip(payslip, await buildYtd(payslip));
  const monthLabel = `${payslip.payPeriodYear}-${String(payslip.payPeriodMonth).padStart(2, '0')}`;
  const empCode = payslip.employee?.employeeCode || 'employee';
  const fileName = `payslip-${empCode}-${monthLabel}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}

/**
 * Ensure a public (no-login) share token exists for an Approved/Paid payslip.
 * @route POST /api/payroll/:id/share  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {{token: string}}; 400 unless Approved/Paid
 */
// POST /api/payroll/:id/share  (HR/Admin)
// Ensure the payslip has a public token and return it, so HR can paste a
// no-login download link into an email. Only Approved/Paid payslips can be
// shared (Drafts/OnHold must not leak).
const sharePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (!['Approved', 'Paid'].includes(payslip.status)) {
    res.status(400);
    throw new Error('Only Approved or Paid payslips can be shared');
  }
  if (!payslip.publicToken) {
    payslip.publicToken = crypto.randomBytes(24).toString('hex');
    await payslip.save();
  }
  res.json({ token: payslip.publicToken });
});

/**
 * Stamp emailedAt to record that the payslip was sent (delivery done externally).
 * @route POST /api/payroll/:id/mark-sent  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {{payslip: Object}}
 */
// POST /api/payroll/:id/mark-sent  (HR/Admin) — stamp emailedAt for the
// "already sent" remark (delivery happens from HR's own mailbox via compose).
const markPayslipSent = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  payslip.emailedAt = new Date();
  await payslip.save();
  res.json({ payslip });
});

/**
 * Preview or send the payslip email (with PDF attached and a public link).
 * @route POST /api/payroll/:id/email  (HR/Admin)
 * @param {string} req.params.id - payslip id (must be Approved/Paid)
 * @param {boolean} [req.body.preview] - true returns the draft without sending
 * @param {string} [req.body.subject] / [req.body.body] - HR overrides
 * @returns {{to, subject, body, attachments, link}} in preview, else {{mailed}}
 * @sideeffect enqueues the email and stamps emailedAt when not preview
 */
// POST /api/payroll/:id/email  { subject?, body?, preview? }  (HR/Admin)
// Preview or send the payslip email from the company mailbox with the payslip
// PDF attached — HR sees and can edit the exact subject + body first. Mirrors
// the offer/appointment letter flow so every portal email is review-then-send.
const emailPayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate(PAYSLIP_PDF_POPULATE);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (!['Approved', 'Paid'].includes(payslip.status)) {
    res.status(400);
    throw new Error('Only Approved or Paid payslips can be emailed');
  }
  const email = payslip.employee?.user?.email;
  if (!email) {
    res.status(400);
    throw new Error('This employee has no email on file.');
  }

  // Ensure a public (no-login) link exists so it can be included in the body.
  if (!payslip.publicToken) {
    payslip.publicToken = crypto.randomBytes(24).toString('hex');
    await payslip.save();
  }
  const link = `${req.protocol}://${req.get('host')}/api/payroll/public/${payslip.publicToken}`;
  const period = `${MONTH_NAMES[payslip.payPeriodMonth]} ${payslip.payPeriodYear}`;
  const name = `${payslip.employee?.user?.firstName || ''} ${payslip.employee?.user?.lastName || ''}`.trim();
  const monthLabel = `${payslip.payPeriodYear}-${String(payslip.payPeriodMonth).padStart(2, '0')}`;
  const empCode = payslip.employee?.employeeCode || 'employee';
  const fileName = `payslip-${empCode}-${monthLabel}.pdf`;

  const defaults = {
    subject: `Payslip · ${period}`,
    body:
      `Dear ${name || 'Employee'},\n\n` +
      `Please find attached your payslip for ${period}. You can also view and download it anytime from the link below:\n\n` +
      `${link}\n\n` +
      `Regards,\n${req.user?.fullName || 'HR Team'}`,
  };
  if (req.body.preview) {
    return res.json({ to: email, subject: defaults.subject, body: defaults.body, attachments: [fileName], link });
  }

  const subject = String(req.body.subject || '').trim() || defaults.subject;
  const body = String(req.body.body || '').trim() ? String(req.body.body) : defaults.body;
  const buffer = await renderPayslip(payslip, await buildYtd(payslip));
  await enqueueMail(
    {
      to: email,
      subject,
      text: body,
      replyTo: req.user?.email,
      attachments: [{ filename: fileName, content: buffer.toString('base64'), contentType: 'application/pdf' }],
    },
    { type: 'payroll', id: payslip._id }
  );
  payslip.emailedAt = new Date();
  await payslip.save();
  res.json({ mailed: [email] });
});

/**
 * Public: open a payslip PDF from its share token (no login).
 * @route GET /api/payroll/public/:token  (PUBLIC)
 * @param {string} req.params.token - publicToken (payslip must be Approved/Paid)
 * @returns {application/pdf} inline
 */
// GET /api/payroll/public/:token  — public; opens a payslip PDF from the
// shareable link with no login required.
const downloadPublicPayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findOne({
    publicToken: req.params.token,
    status: { $in: ['Approved', 'Paid'] },
  }).populate(PAYSLIP_PDF_POPULATE);
  if (!payslip) {
    res.status(404);
    throw new Error('This payslip link is invalid or has expired.');
  }
  const buffer = await renderPayslip(payslip, await buildYtd(payslip));
  const monthLabel = `${payslip.payPeriodYear}-${String(payslip.payPeriodMonth).padStart(2, '0')}`;
  const empCode = payslip.employee?.employeeCode || 'employee';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${empCode}-${monthLabel}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

/**
 * Delete a payslip (Draft only).
 * @route DELETE /api/payroll/:id  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {{id: string, deleted: boolean}}; 400 unless Draft
 */
// DELETE /api/payroll/:id  (HR/Admin) — Draft only
const deletePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await guardPayslipScope(req, res, payslip);
  if (payslip.status !== 'Draft') {
    res.status(400);
    throw new Error('Only Draft payslips can be deleted');
  }
  await payslip.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Derive a payslip's earnings + standard statutory deductions from the employee's
 * assigned salary structure × CTC (effective for the month). Earnings are the
 * full monthly value; the unpaid days are returned as a `lopDeduction`.
 * Backs the manual payslip editor's "Fill from salary structure" action.
 * @route GET /api/payroll/derive-salary?employee=&year=&month=&paidDays=&daysInMonth=  (HR/Admin)
 * @returns {{needsSetup, structure, annualCtc, earnings, deductions, monthlyGross}}
 */
const deriveSalaryForEditor = asyncHandler(async (req, res) => {
  if (!req.query.employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  const profile = await EmployeeProfile.findById(req.query.employee).populate('salaryStructure');
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const daysInMonth = Number(req.query.daysInMonth) || new Date(year, month, 0).getDate();
  const paidDays = req.query.paidDays != null && req.query.paidDays !== '' ? Number(req.query.paidDays) : daysInMonth;
  const ctc = resolveCtcForMonth(profile, year, month);
  const st = profile.salaryStructure;
  if (!st || !ctc) {
    return res.json({
      needsSetup: true,
      structure: st ? { _id: st._id, name: st.name } : null,
      annualCtc: ctc || 0,
    });
  }
  const { earnings, deductions, gross } = deriveSalary(st.components, ctc, paidDays, daysInMonth);
  res.json({
    needsSetup: false,
    structure: { _id: st._id, name: st.name, components: st.components },
    annualCtc: ctc,
    earnings,
    deductions,
    monthlyGross: gross,
  });
});

/**
 * Apply a salary hike / increment to an employee: revises the annual CTC and
 * records the raise in the CTC history. A hike effective this month (or earlier)
 * updates the current CTC immediately; a future-dated hike is stored and takes
 * effect automatically when that month's payroll runs (resolveCtcForMonth).
 * Record a CTC revision — up OR down.
 *
 * A negative percent/amount, or a lower "set to", records a reduction. The only
 * value refused is one that changes nothing, or that would take the CTC below
 * zero. Reductions used to be blocked, which meant HR edited the CTC by hand
 * and the revision history lost the one thing it exists to record.
 * @route POST /api/payroll/employees/:id/hike  (HR/Admin)
 * @param {string} req.body.mode - 'percent' | 'amount' | 'set'
 * @param {number} req.body.value - the % (percent), ₹ change (amount, may be negative), or absolute CTC (set)
 * @param {string} [req.body.newStructure] - optionally switch the salary structure
 * @param {number} req.body.effectiveYear / req.body.effectiveMonth
 * @param {string} [req.body.reason]
 * @returns {{profile, applied, entry}}
 */
/**
 * Active employees whose salary basis is incomplete — no salary structure, or no
 * annual CTC, or both. Without both, payroll cannot compute anything for them:
 * they come out of a run with a ₹0 payslip, and even the late-arrival penalty is
 * ₹0 because its ₹200/₹400 rate keys off monthly Basic. HR gets this as a
 * standing alert rather than discovering it at run time.
 *
 * Deliberately lightweight (a projected, lean query on one collection) — it is
 * polled by a banner on page load, not by an explicit user action.
 * @route GET /api/payroll/salary-setup-status  (HR/Admin, payroll.manage)
 * @returns {{count: number, employees: Array<{id, employeeCode, name, designation, department, missing: string[]}>}}
 */
const salarySetupStatus = asyncHandler(async (req, res) => {
  const profiles = await EmployeeProfile.find({
    ...employeeProfileScope(req),
    $or: [
      { salaryStructure: { $in: [null, undefined] } },
      { annualCtc: { $in: [null, undefined, 0] } },
    ],
  })
    .select('employeeCode designation department salaryStructure annualCtc dateOfExit user')
    .populate('user', 'firstName lastName isActive')
    .lean();

  const today = new Date();
  const employees = profiles
    // Someone who has already left is not a payroll problem.
    .filter((p) => p.user && p.user.isActive !== false && !(p.dateOfExit && new Date(p.dateOfExit) < today))
    .map((p) => ({
      id: String(p._id),
      employeeCode: p.employeeCode || '',
      name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim(),
      designation: p.designation || '',
      department: p.department || '',
      missing: [
        !p.salaryStructure ? 'structure' : null,
        !p.annualCtc ? 'ctc' : null,
      ].filter(Boolean),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ count: employees.length, employees });
});

const giveHike = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id).populate('user', 'firstName lastName');
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  if (cannotManageProfile(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  const { mode, value, newStructure, effectiveYear, effectiveMonth, reason } = req.body;
  const prevCtc = profile.annualCtc || 0;
  const v = Number(value) || 0;

  // A revision may go DOWN as well as up. Demotions, a corrected offer, a move
  // to a shorter week — all are real, and refusing them forced HR to fix the
  // CTC by hand, which left no record of what changed or why. So a negative
  // percent/amount, or a lower "set to", is accepted; only a revision that
  // changes nothing is refused, because it would be an empty history entry.
  if (v === 0) {
    res.status(400);
    throw new Error('Enter a value — a revision of zero changes nothing.');
  }
  if ((mode === 'percent' || mode === 'amount') && !prevCtc) {
    res.status(400);
    throw new Error('Set a current CTC for this employee before applying a percentage/amount revision (or use "Set to" mode).');
  }
  let newCtc;
  if (mode === 'percent') newCtc = Math.round(prevCtc * (1 + v / 100));
  else if (mode === 'amount') newCtc = Math.round(prevCtc + v);
  else if (mode === 'set') newCtc = Math.round(v);
  else { res.status(400); throw new Error('Invalid revision mode.'); }

  if (newCtc < 0) {
    res.status(400);
    throw new Error(`That reduction would take the CTC below zero (${prevCtc.toLocaleString('en-IN')} → ${newCtc.toLocaleString('en-IN')}).`);
  }
  if (newCtc === prevCtc) {
    res.status(400);
    throw new Error('That leaves the CTC unchanged.');
  }

  const now = new Date();
  const eYear = Number(effectiveYear) || now.getFullYear();
  const eMonth = Number(effectiveMonth) || now.getMonth() + 1;
  const prevStructure = profile.salaryStructure || null;
  const entry = {
    previousCtc: prevCtc,
    newCtc,
    mode,
    value: v,
    previousStructure: prevStructure,
    newStructure: newStructure || prevStructure,
    effectiveYear: eYear,
    effectiveMonth: eMonth,
    reason: (reason || '').trim(),
    by: req.user._id,
    byName: req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim(),
    at: now,
  };
  profile.ctcHistory = [...(profile.ctcHistory || []), entry];

  // Apply to the live CTC now only if the hike is effective on/before this month;
  // a future-dated hike stays pending and is resolved per-month at run time.
  const effectiveNow = eYear * 12 + (eMonth - 1) <= now.getFullYear() * 12 + now.getMonth();
  if (effectiveNow) {
    profile.annualCtc = newCtc;
    if (newStructure) profile.salaryStructure = newStructure;
  }
  await profile.save();
  res.json({ profile, applied: effectiveNow, entry });
});

module.exports = {
  listMyPayslips,
  requestMyPayslip,
  requestMyPayslipChange,
  approvePayslipRelease,
  finalisePayslipRelease,
  getMyPayslip,
  myAttendanceSummary,
  deriveSalaryForEditor,
  giveHike,
  salarySetupStatus,
  exportPayrollSheet,
  // exported for unit tests
  computeEmployeeRun,
  deriveSalary,
  employerContributionsFor,
  applyEmployerContributions,
  resolveCtcForMonth,
  buildRunFields,
  buildPayrollSheetRow,
  buildPayrollWorkbook,
  listPayslips,
  previewPayrollRun,
  runPayroll,
  previewEmployeeRun,
  runEmployeePayroll,
  getPayslip,
  createPayslip,
  updatePayslip,
  approvePayslip,
  markPayslipPaid,
  deletePayslip,
  downloadPayslipPdf,
  downloadMyPayslipPdf,
  sharePayslip,
  markPayslipSent,
  emailPayslip,
  downloadPublicPayslip,
};
