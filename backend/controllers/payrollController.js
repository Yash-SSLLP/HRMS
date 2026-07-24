/**
 * Payroll controller — payslips (Payroll) and the monthly payroll run. Employees
 * view/download their own Approved/Paid payslips and an attendance-policy summary.
 * HR list/export payslips, run payroll org-wide (Draft seeded from the last slip)
 * or per-employee (salary structure % × CTC, prorated by attendance, with the
 * 2-paid-leaves/month + late-penalty policy and active loan EMIs), then edit /
 * approve / mark Paid, render PDFs (with FY-to-date figures), and share/email via
 * a public no-login link. Status flow: Draft → Approved → Paid.
 */
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Payroll = require('../models/Payroll');
const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const Loan = require('../models/Loan');
const Holiday = require('../models/Holiday');
const { monthRangeIST, ymdIST } = require('../utils/dateHelpers');
const { renderPayslip } = require('../services/payslipPdf');
const { enqueueMail } = require('../services/email');
// (exportPayroll below builds the month CSV by hand — no spreadsheet lib needed)

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
  }).sort({ payPeriodYear: -1, payPeriodMonth: -1 });
  res.json({ count: payslips.length, payslips });
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
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
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
const listPayslips = asyncHandler(async (req, res) => {
  const { employee, year, month, status } = req.query;
  const filter = {};
  if (employee) filter.employee = employee;
  if (year) filter.payPeriodYear = Number(year);
  if (month) filter.payPeriodMonth = Number(month);
  if (status) filter.status = status;

  const payslips = await Payroll.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user designation',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ payPeriodYear: -1, payPeriodMonth: -1, createdAt: -1 });
  res.json({ count: payslips.length, payslips });
});

/**
 * Export a month's payroll as an Excel-compatible CSV (one row per employee).
 * @route GET /api/payroll/export?year=&month=&status=  (HR/Admin)
 * @param {number} [req.query.year] / [req.query.month]
 * @param {string} [req.query.status]
 * @returns {text/csv} UTF-8 with BOM
 */
// GET /api/payroll/export?year=&month=&status=  (HR/Admin)
// Excel-compatible CSV of the whole month's payroll — one row per employee
// with every earning/deduction component. Opens directly in Excel.
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const exportPayroll = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const filter = { payPeriodYear: year, payPeriodMonth: month };
  if (req.query.status) filter.status = req.query.status;

  const payslips = await Payroll.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode designation department user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ 'employee.employeeCode': 1, createdAt: 1 });

  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Employee Code', 'Name', 'Email', 'Designation', 'Department',
    'Month', 'Year', 'Working Days', 'Paid Days', 'LOP Days',
    'Basic', 'HRA', 'Special Allowance', 'Conveyance', 'Medical', 'LTA', 'Bonus', 'Overtime', 'Leave Incentive', 'Other Earnings',
    'Gross Salary',
    'EPF', 'ESIC', 'Professional Tax', 'TDS', 'Loan Recovery', 'Late Penalty', 'Other Deductions',
    'Total Deductions', 'Net Pay',
    'Employer EPF', 'Employer EPS', 'Employer ESIC', 'Gratuity',
    'Status', 'Payment Date', 'Payment Reference',
  ];
  const rows = payslips.map((p) => {
    const u = p.employee?.user || {};
    const e = p.earnings || {};
    const d = p.deductions || {};
    const c = p.employerContributions || {};
    return [
      p.employee?.employeeCode, `${u.firstName || ''} ${u.lastName || ''}`.trim(), u.email,
      p.employee?.designation, p.employee?.department,
      MONTH_NAMES[p.payPeriodMonth], p.payPeriodYear, p.workingDays, p.paidDays, p.lopDays,
      e.basic, e.hra, e.specialAllowance, e.conveyanceAllowance, e.medicalAllowance, e.lta, e.bonus, e.overtime, e.leaveIncentive, e.otherEarnings,
      p.grossSalary,
      d.epf, d.esic, d.professionalTax, d.tds, d.loanRecovery, d.latePenalty, d.otherDeductions,
      p.totalDeductions, p.netPay,
      c.epf, c.eps, c.esic, c.gratuity,
      p.status,
      p.paymentDate ? new Date(p.paymentDate).toLocaleDateString('en-IN') : '',
      p.paymentReference,
    ].map(esc).join(',');
  });
  const csv = [header.map(esc).join(','), ...rows].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="payroll-${year}-${String(month).padStart(2, '0')}.csv"`
  );
  // BOM so Excel detects UTF-8 (₹, names with accents, etc.).
  res.send('﻿' + csv);
});

// ===== Monthly payroll run =====
// "Initiate salaries" for a whole month: every active employee gets a Draft
// payslip for the period, seeded from their most recent payslip (new joiners
// get a blank draft for HR to fill in). Preview with GET, execute with POST.

async function buildRunRows(year, month) {
  const profiles = await EmployeeProfile.find()
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
 * @returns {{year, month, count, alreadyGenerated, toGenerate, rows}}
 */
// GET /api/payroll/run?year=&month=  — preview who gets what
const previewPayrollRun = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const rows = await buildRunRows(year, month);
  res.json({
    year,
    month,
    count: rows.length,
    alreadyGenerated: rows.filter((r) => r.existing).length,
    toGenerate: rows.filter((r) => !r.existing).length,
    rows: rows.map((r) => r.row),
  });
});

/**
 * Execute the org-wide monthly run: create Draft payslips seeded from each
 * employee's most recent payslip (blank for new joiners); never overwrites existing.
 * @route POST /api/payroll/run  (HR/Admin)
 * @param {number} req.body.year - required
 * @param {number} req.body.month - required 1-12
 * @returns {{year, month, created, skippedExisting, needsSetup, payslips}} (201)
 */
// POST /api/payroll/run  { year, month }  — create the Draft payslips
const runPayroll = asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) {
    res.status(400);
    throw new Error('A valid year and month are required');
  }

  const rows = await buildRunRows(year, month);
  const daysInMonth = new Date(year, month, 0).getDate();
  const created = [];
  const derivedCount = [];
  const copiedCount = [];
  const blank = [];
  for (const r of rows) {
    if (r.existing) continue; // never overwrite an existing payslip

    // Preferred: derive the payslip from the employee's salary structure × CTC,
    // prorated by attendance, with the leave/late policy + loan EMIs (same engine
    // as the per-employee run and the manual editor's "fill from structure").
    if (r.hasSalarySetup) {
      const computed = await computeEmployeeRun(r.profile, year, month);
      if (!computed.needsSetup) {
        const pol = computed.policy;
        const payslip = await Payroll.create({
          employee: r.profile._id,
          payPeriodYear: year,
          payPeriodMonth: month,
          workingDays: computed.daysInMonth,
          paidDays: computed.paidDays,
          lopDays: computed.lopDays,
          earnings: computed.earnings,
          deductions: {
            epf: computed.statutoryDeductions.epf,
            esic: computed.statutoryDeductions.esic,
            professionalTax: computed.statutoryDeductions.professionalTax,
            loanRecovery: computed.loanRecovery,
            latePenalty: computed.latePenalty,
          },
          status: 'Draft',
          remarks: `Payroll run: ${r.profile.salaryStructure.name} @ ₹${(computed.ctc || 0).toLocaleString('en-IN')} CTC · ${computed.paidDays}/${computed.daysInMonth} paid days`
            + ` · leave ${pol.leaveTaken}/${pol.paidLeaveQuota}` + (pol.excessLeave ? ` (${pol.excessLeave}d LOP)` : pol.unusedLeave ? ` (₹${pol.leaveIncentive} incentive)` : '')
            + (pol.noPunchDays ? ` · no-punch ${pol.noPunchDays}d LOP` : '')
            + ` · late ${pol.lateDays}/${pol.lateAllowance}` + (pol.excessLate ? ` (₹${pol.latePenalty} penalty)` : ''),
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
    skippedExisting: rows.filter((r) => r.existing).length,
    needsSetup: blank,
    payslips: created,
  });
});

// ===== Per-employee payroll run (calendar view) =====
// Salary comes from the employee's assigned SalaryStructure percentages ×
// annual CTC, prorated by paid days derived from their actual punch-in/out
// attendance for the month, with active loan/advance EMIs as deductions.

// Attendance policy constants (mirror attendanceController's WORKDAY_START_HOUR).
const WORKDAY_START_HOUR = 10;   // check-in after 10:00 AM IST counts as late
const PAID_LEAVE_QUOTA = 2;      // paid leave days granted each month
const LATE_ALLOWANCE = 5;        // free late arrivals each month
const LATE_THRESHOLD_BASIC = 25000; // monthly Basic cut-off for the penalty rate
const LATE_RATE_LOW = 200;       // ₹/day when monthly Basic < threshold
const LATE_RATE_HIGH = 400;      // ₹/day when monthly Basic >= threshold

// Statutory deduction constants (employee side). Used to auto-fill standard
// deductions when deriving a payslip from a salary structure. All editable by HR.
const EPF_EMP_RATE = 0.12;          // Employee PF: 12% of Basic
const ESIC_EMP_RATE = 0.0075;       // Employee ESIC: 0.75% of gross
const ESIC_WAGE_CEILING = 21000;    // ESIC applies only when monthly gross <= this
const PROFESSIONAL_TAX = 200;       // Flat monthly professional tax

// Derive monthly earnings + standard statutory deductions from a salary
// structure's component percentages applied to an annual CTC, prorated by paid
// days. Pure + side-effect-free so it can back both the payroll run and the
// manual payslip editor's "fill from structure" action.
function deriveSalary(components, annualCtc, paidDays, daysInMonth) {
  const c = components || {};
  const dim = Number(daysInMonth) || 30;
  const factor = dim ? Math.min(1, Math.max(0, (Number(paidDays) ?? dim) / dim)) : 1;
  const comp = (pct) => Math.round((((Number(pct) || 0) / 100) * (Number(annualCtc) || 0) / 12) * factor);
  const earnings = {
    basic: comp(c.basicPct),
    hra: comp(c.hraPct),
    specialAllowance: comp(c.specialAllowancePct),
    conveyanceAllowance: comp(c.conveyancePct),
    medicalAllowance: comp(c.medicalPct),
    lta: comp(c.ltaPct),
  };
  const gross = Object.values(earnings).reduce((a, v) => a + v, 0);
  const deductions = {
    epf: Math.round(earnings.basic * EPF_EMP_RATE),
    esic: gross <= ESIC_WAGE_CEILING ? Math.round(gross * ESIC_EMP_RATE) : 0,
    professionalTax: PROFESSIONAL_TAX,
  };
  return { earnings, deductions, gross };
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
  const holidays = await Holiday.find({ date: { $gte: start, $lt: end } }).select('date').lean().catch(() => []);
  const holidayKeys = new Set((holidays || []).map((h) => ymdIST(h.date)));
  const recByKey = new Map(records.map((r) => [ymdIST(r.date), r]));
  const CREDITED = new Set(['Present', 'HalfDay', 'OnLeave', 'Holiday', 'WeeklyOff']);
  const todayKey = ymdIST(new Date());
  const joinKey = profile.dateOfJoining ? ymdIST(profile.dateOfJoining) : null;
  const exitKey = profile.dateOfExit ? ymdIST(profile.dateOfExit) : null;
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

  // ----- Monthly paid-leave quota (2 days) -----
  // Leave days beyond the quota become LOP; unused quota converts to extra pay
  // (leave incentive) at one day's salary each. Settled monthly, never carried.
  const excessLeave = Math.max(0, onLeaveDays - PAID_LEAVE_QUOTA);
  const unusedLeave = Math.max(0, PAID_LEAVE_QUOTA - onLeaveDays);

  // ----- Late arrivals (check-in after WORKDAY_START_HOUR) on worked days -----
  const lateDays = records.filter((r) => {
    if (!r.checkIn || !['Present', 'HalfDay'].includes(r.status)) return false;
    const cutoff = new Date(new Date(r.date).getTime() + WORKDAY_START_HOUR * 60 * 60 * 1000);
    return new Date(r.checkIn) > cutoff;
  }).length;
  const excessLate = Math.max(0, lateDays - LATE_ALLOWANCE);

  // Paid days: everything except Absent (full LOP), no-punch days (full LOP unless
  // regularised), half of each HalfDay, and leave days beyond the monthly paid
  // quota.
  const paidDays = +(daysInMonth - absent - noPunchDays - 0.5 * halfDay - excessLeave).toFixed(1);
  const lopDays = +(daysInMonth - paidDays).toFixed(1);

  // Active loan/advance recovery for this employee (Loan.employee is the User).
  const userId = profile.user?._id || profile.user;
  const loans = await Loan.find({ employee: userId, status: { $in: ['Approved', 'Active'] } });
  const loanRecovery = Math.round(loans.reduce((a, l) => a + (l.emi || 0), 0));

  const st = profile.salaryStructure; // populated
  // CTC effective for THIS pay month (honours future-dated / historical hikes).
  const ctc = resolveCtcForMonth(profile, year, month);
  let earnings = null;
  let statutoryDeductions = { epf: 0, esic: 0, professionalTax: 0 };
  let monthlyBasic = 0;   // full (unprorated) Basic — drives the late-penalty rate
  let perDayPay = 0;      // full monthly gross ÷ days in month — one day's pay
  if (st && ctc > 0) {
    const c = st.components || {};
    const factor = daysInMonth ? paidDays / daysInMonth : 1;
    const comp = (pct) => Math.round((((pct || 0) / 100) * ctc / 12) * factor);
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
    };
    // Standard statutory deductions on the same (prorated) component base used by
    // the manual editor's derive, so all payroll paths fill the same values.
    const baseGross = earnings.basic + earnings.hra + earnings.specialAllowance
      + earnings.conveyanceAllowance + earnings.medicalAllowance + earnings.lta;
    statutoryDeductions = {
      epf: Math.round(earnings.basic * EPF_EMP_RATE),
      esic: baseGross <= ESIC_WAGE_CEILING ? Math.round(baseGross * ESIC_EMP_RATE) : 0,
      professionalTax: PROFESSIONAL_TAX,
    };
  }
  const leaveIncentive = earnings ? earnings.leaveIncentive : 0;
  const gross = earnings ? Object.values(earnings).reduce((a, v) => a + v, 0) : 0;

  // Late-arrival penalty for days beyond the monthly allowance. This is a flat
  // per-day amount, so it applies (and is shown to the employee) even before the
  // salary is set up — unlike the leave incentive, which needs a per-day pay to
  // value. When Basic isn't known yet, monthlyBasic is 0 → the lower ₹200 rate.
  const lateRate = monthlyBasic < LATE_THRESHOLD_BASIC ? LATE_RATE_LOW : LATE_RATE_HIGH;
  const latePenalty = excessLate * lateRate;

  // Working-hours roll-up. A "worked day" is any day with real punch hours.
  // Sundays and holidays are excluded from the average — unless the employee
  // actually worked that day, in which case its hours count and the day is
  // earned back as a compensatory off (comp-off).
  const isRestDay = (r) =>
    new Date(r.date).getDay() === 0 || r.status === 'Holiday' || r.status === 'WeeklyOff';
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
    // Attendance-policy roll-up: monthly paid-leave quota + late allowance.
    policy: {
      paidLeaveQuota: PAID_LEAVE_QUOTA,
      leaveTaken: onLeaveDays,
      excessLeave,          // leave days beyond the quota → added to LOP
      unusedLeave,          // quota not used → paid out as leaveIncentive
      leaveIncentive,
      noPunchDays,          // past working days with no punch (LOP unless regularised)
      lateAllowance: LATE_ALLOWANCE,
      lateDays,
      excessLate,           // late days beyond the allowance → penalised
      lateRate,
      latePenalty,
      monthlyBasic: Math.round(monthlyBasic),
    },
    paidDays, lopDays,
    ctc, // CTC effective for this pay month (post hike resolution)
    statutoryDeductions, // EPF / ESIC / PT derived from the components
    loans: loans.map((l) => ({ _id: l._id, type: l.type, emi: l.emi, balance: l.balance, status: l.status })),
    loanRecovery,
    latePenalty,
    earnings, gross,
    // Take-home estimate only once salary exists; before that gross is 0 and a
    // net would be a meaningless negative (the late penalty is still shown above).
    estimatedNet: earnings ? gross - loanRecovery - latePenalty : 0,
    needsSetup: !earnings,
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
 * @returns {{payslip, computed}} (201); 400 if salary not set up or slip already Approved/Paid
 */
// POST /api/payroll/run-employee  { employee, year, month }
// Create or refresh the month's Draft payslip from structure + attendance + loans.
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
  const computed = await computeEmployeeRun(profile, year, month);
  if (computed.needsSetup) {
    res.status(400);
    throw new Error('Assign a salary structure and annual CTC to this employee first.');
  }

  let payslip = await Payroll.findOne({ employee: profile._id, payPeriodYear: year, payPeriodMonth: month });
  if (payslip && ['Approved', 'Paid'].includes(payslip.status)) {
    res.status(400);
    throw new Error(`The ${MONTH_NAMES[month]} payslip is already ${payslip.status} - it can't be regenerated.`);
  }
  const p = computed.policy;
  const fields = {
    workingDays: computed.daysInMonth,
    paidDays: computed.paidDays,
    lopDays: computed.lopDays,
    earnings: computed.earnings,
    deductions: {
      // Preserve HR-entered non-derivable deductions (TDS, other), (re)compute
      // the deterministic ones from the structure/attendance.
      ...(payslip?.deductions?.toObject?.() || {}),
      epf: computed.statutoryDeductions.epf,
      esic: computed.statutoryDeductions.esic,
      professionalTax: computed.statutoryDeductions.professionalTax,
      loanRecovery: computed.loanRecovery,
      latePenalty: computed.latePenalty,
    },
    status: 'Draft',
    remarks: `Payroll run: ${profile.salaryStructure.name} @ ₹${(computed.ctc || 0).toLocaleString('en-IN')} CTC · ${computed.paidDays}/${computed.daysInMonth} paid days · loan EMI ₹${computed.loanRecovery}`
      + ` · leave ${p.leaveTaken}/${p.paidLeaveQuota}`
      + (p.excessLeave ? ` (${p.excessLeave}d LOP)` : p.unusedLeave ? ` (₹${p.leaveIncentive} incentive)` : '')
      + (p.noPunchDays ? ` · no-punch ${p.noPunchDays}d LOP` : '')
      + ` · late ${p.lateDays}/${p.lateAllowance}` + (p.excessLate ? ` (₹${p.latePenalty} penalty @ ₹${p.lateRate}/d)` : ''),
  };
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
  const payslip = await Payroll.findById(req.params.id).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
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
  const profile = await EmployeeProfile.findById(employee);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  const payslip = await Payroll.create(req.body);
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
  if (payslip.status === 'Paid') {
    res.status(400);
    throw new Error('Paid payslips cannot be edited');
  }
  // Don't allow changing identity fields
  delete req.body.employee;
  delete req.body.payPeriodYear;
  delete req.body.payPeriodMonth;

  Object.assign(payslip, req.body);
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

/**
 * Download a payslip PDF (with FY-to-date figures).
 * @route GET /api/payroll/:id/pdf  (HR/Admin)
 * @param {string} req.params.id - payslip id
 * @returns {application/pdf}
 */
// GET /api/payroll/:id/pdf  (HR/Admin)
const downloadPayslipPdf = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
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
  }).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await streamPayslipPdf(payslip, res);
});

// Indian financial year start: April-to-March
function fyStartKey(year, month) {
  return month >= 4 ? year * 100 + 4 : (year - 1) * 100 + 4;
}

// Sum each earnings/deductions component across this employee's payslips
// within the same financial year, up to and including the current period.
async function computeYtd(payslip) {
  const periodKey = (p) => p.payPeriodYear * 100 + p.payPeriodMonth;
  const startKey = fyStartKey(payslip.payPeriodYear, payslip.payPeriodMonth);
  const currentKey = periodKey(payslip);

  const others = await Payroll.find({
    employee: payslip.employee,
    status: { $in: ['Approved', 'Paid'] },
  });

  // Always include the current payslip even if it's Draft so its YTD reflects itself
  const seen = new Set([String(payslip._id)]);
  const list = [payslip];
  for (const p of others) {
    if (seen.has(String(p._id))) continue;
    if (periodKey(p) < startKey || periodKey(p) > currentKey) continue;
    seen.add(String(p._id));
    list.push(p);
  }

  const earnings = {};
  const deductions = {};
  for (const p of list) {
    const e = p.earnings?.toObject?.() || p.earnings || {};
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'number') earnings[k] = (earnings[k] || 0) + v;
    }
    const d = p.deductions?.toObject?.() || p.deductions || {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'number') deductions[k] = (deductions[k] || 0) + v;
    }
  }
  return { earnings, deductions };
}

async function streamPayslipPdf(payslip, res) {
  const ytd = await computeYtd(payslip);
  const buffer = await renderPayslip(payslip, ytd);
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
  const payslip = await Payroll.findById(req.params.id).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
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
  const ytd = await computeYtd(payslip);
  const buffer = await renderPayslip(payslip, ytd);
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
  }).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('This payslip link is invalid or has expired.');
  }
  const ytd = await computeYtd(payslip);
  const buffer = await renderPayslip(payslip, ytd);
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
  if (payslip.status !== 'Draft') {
    res.status(400);
    throw new Error('Only Draft payslips can be deleted');
  }
  await payslip.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Derive a payslip's earnings + standard statutory deductions from the employee's
 * assigned salary structure × CTC (effective for the month), prorated by paid days.
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
 * @route POST /api/payroll/employees/:id/hike  (HR/Admin)
 * @param {string} req.body.mode - 'percent' | 'amount' | 'set'
 * @param {number} req.body.value - the % (percent), ₹ increase (amount), or absolute CTC (set)
 * @param {string} [req.body.newStructure] - optionally switch the salary structure
 * @param {number} req.body.effectiveYear / req.body.effectiveMonth
 * @param {string} [req.body.reason]
 * @returns {{profile, applied, entry}}
 */
const giveHike = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id).populate('user', 'firstName lastName');
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  const { mode, value, newStructure, effectiveYear, effectiveMonth, reason } = req.body;
  const prevCtc = profile.annualCtc || 0;
  const v = Number(value) || 0;
  if (v <= 0) {
    res.status(400);
    throw new Error('Enter a positive hike value.');
  }
  if ((mode === 'percent' || mode === 'amount') && !prevCtc) {
    res.status(400);
    throw new Error('Set a current CTC for this employee before applying a percentage/amount hike (or use "Set to" mode).');
  }
  let newCtc;
  if (mode === 'percent') newCtc = Math.round(prevCtc * (1 + v / 100));
  else if (mode === 'amount') newCtc = Math.round(prevCtc + v);
  else if (mode === 'set') newCtc = Math.round(v);
  else { res.status(400); throw new Error('Invalid hike mode.'); }
  if (newCtc <= prevCtc) {
    res.status(400);
    throw new Error('The new CTC must be higher than the current CTC.');
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
  getMyPayslip,
  myAttendanceSummary,
  deriveSalaryForEditor,
  giveHike,
  // exported for unit tests
  deriveSalary,
  resolveCtcForMonth,
  listPayslips,
  exportPayroll,
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
